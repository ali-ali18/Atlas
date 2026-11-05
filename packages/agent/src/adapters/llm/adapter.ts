import { formatModelRef, pickModelFor } from "@workspace/shared";
import type { ModelChainEntry, ModelProvider, NoModelReason, ProviderHealthReason, RoleChains, SpendCeilings, SpendSoFar } from "@workspace/shared";
import type { ProviderStreamChat } from "@workspace/llm";
import type { Clock } from "../../ports/clock.js";
import type { Llm, LlmChatRequest, LlmRole, LlmStreamEvent, LlmToolCall, LlmUsage } from "../../ports/llm.js";
import { DEFAULT_COOLDOWNS, type FailureCooldowns, classifyFailure, reasonText } from "./failure.js";
import { type ProviderHealthStore, createInMemoryHealth } from "./health.js";
import { parseToolArgs, toLegacyMessages, toLegacyTools } from "./map.js";

/**
 * Transporte do legado: generoso de propósito. O baseline da v2 (`docs/ops/v4-baseline.md`)
 * mostrou o `decision-budget` matando passos saudáveis em 30s sem 1º evento / 20s ocioso /
 * 90s no total. Aqui o 1º evento e a ociosidade têm 120s e NÃO há teto total enquanto os
 * tokens fluem (o 1h abaixo é o máximo que o transporte aceita, não um corte de custo/tempo).
 */
export const DEFAULT_TRANSPORT = { firstEventMs: 120_000, idleMs: 120_000, totalMs: 3_600_000 } as const;

export type LlmTransportTimeouts = { firstEventMs: number; idleMs: number; totalMs: number };

export type LlmAdapterConfig = {
	/** Roteador por provedor do packages/llm (`createProviderStreamChat`); injetado para teste com stream falso. */
	streamChat: ProviderStreamChat;
	/** Cadeias por papel (configuráveis; ver `EXAMPLE_ROLE_CHAINS` em shared). */
	chains: RoleChains | (() => RoleChains | Promise<RoleChains>);
	/** Chave do provedor (cofre/configuração). Sem chave, a entrada é pulada. */
	apiKeyFor: (provider: ModelProvider) => string | undefined | Promise<string | undefined>;
	clock: Clock;
	health?: ProviderHealthStore;
	ceilings?: SpendCeilings | (() => SpendCeilings | Promise<SpendCeilings>);
	spend?: SpendSoFar | (() => SpendSoFar | Promise<SpendSoFar>);
	timeouts?: Partial<LlmTransportTimeouts>;
	cooldowns?: Partial<FailureCooldowns>;
	/** Provedores que aceitam um único `system`: os `system` do começo são fundidos em ordem. Padrão: todos. */
	singleSystemProviders?: readonly ModelProvider[];
	contextWindowFor?: (entry: ModelChainEntry) => number | Promise<number>;
};

/** Nenhuma entrada utilizável na cadeia (tudo fora do ar, sem cadeia ou teto do dono). Carrega o motivo real. */
export class LlmUnavailableError extends Error {
	readonly reason: NoModelReason;
	constructor(reason: NoModelReason) {
		super(describeNone(reason));
		this.name = "LlmUnavailableError";
		this.reason = reason;
	}
}

export function describeNone(reason: NoModelReason): string {
	switch (reason.kind) {
		case "no_chain":
			return "Nenhum modelo configurado para este papel.";
		case "ceiling": {
			const origem = reason.source === "bot" ? "do bot" : "da conta";
			const periodo = { day: "diário", week: "semanal", month: "mensal" }[reason.period];
			return `Teto ${periodo} ${origem} atingido: US$ ${reason.spentUsd.toFixed(2)} de US$ ${reason.limitUsd.toFixed(2)}.`;
		}
		default:
			return `Todos os modelos da cadeia estão indisponíveis: ${reason.skipped.map((s) => `${label(s.entry)} (${reasonText(s.reason)})`).join("; ")}.`;
	}
}

const label = (e: ModelChainEntry) => `${e.provider}/${e.model}`;
const resolve = async <T>(v: T | (() => T | Promise<T>)): Promise<T> => (typeof v === "function" ? (v as () => T | Promise<T>)() : v);
const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Adaptador da porta `Llm` sobre o packages/llm.
 *
 * - Falha ANTES de qualquer texto entregue (429, cota, 5xx, rede): marca a saúde do provedor,
 *   emite um `notice` e tenta a próxima entrada na MESMA chamada.
 * - Falha NO MEIO do stream, depois de texto já entregue: NÃO emenda outro modelo (a resposta
 *   misturaria dois autores). Devolve `done` com `finishReason: "error"` e o parcial já
 *   emitido; o kernel refaz o passo e a próxima chamada já pula o provedor em quarentena.
 * - Teto do dono atingido ou cadeia esgotada: lança `LlmUnavailableError` com o motivo real.
 */
export function createLlmAdapter(config: LlmAdapterConfig): Llm {
	const health = config.health ?? createInMemoryHealth();
	const timeouts = { ...DEFAULT_TRANSPORT, ...config.timeouts };
	const cooldowns = { ...DEFAULT_COOLDOWNS, ...config.cooldowns };
	const singleSystem = config.singleSystemProviders ? new Set<ModelProvider>(config.singleSystemProviders) : undefined;

	async function pick(role: LlmRole, tried: ReadonlySet<string>) {
		const all = await resolve(config.chains);
		const chains = { ...all, [role]: (all[role] ?? []).filter((e) => !tried.has(label(e))) } as RoleChains;
		const result = pickModelFor(role, chains, health.snapshot(), config.spend ? await resolve(config.spend) : {}, config.clock.now().getTime(), config.ceilings ? await resolve(config.ceilings) : {});
		// Tudo já tentado nesta chamada: o motivo real é a lista de pulados somada às falhas.
		if ("none" in result && result.none.kind === "no_chain" && (all[role]?.length ?? 0) > 0) {
			return { none: { kind: "all_unavailable", skipped: (all[role] ?? []).map((entry) => ({ entry, reason: "down" as ProviderHealthReason, until: 0 })) } satisfies NoModelReason };
		}
		return result;
	}

	async function* chat(req: LlmChatRequest): AsyncGenerator<LlmStreamEvent> {
		const tried = new Set<string>();
		const failures: Array<{ entry: ModelChainEntry; reason: ProviderHealthReason }> = [];
		let previous: { entry: ModelChainEntry; reason: ProviderHealthReason } | undefined;
		const internal = new AbortController();
		const onAbort = () => internal.abort(req.signal?.reason);
		req.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			for (;;) {
				req.signal?.throwIfAborted();
				const picked = await pick(req.role, tried);
				if ("none" in picked) {
					// Falhas desta chamada entram no motivo para a mensagem ser honesta.
					if (picked.none.kind === "all_unavailable" && failures.length > 0) {
						const seen = new Set(picked.none.skipped.map((s) => label(s.entry)));
						const extra = failures.filter((f) => !seen.has(label(f.entry))).map((f) => ({ entry: f.entry, reason: f.reason, until: 0 }));
						throw new LlmUnavailableError({ kind: "all_unavailable", skipped: [...extra, ...picked.none.skipped] });
					}
					throw new LlmUnavailableError(picked.none);
				}
				const { entry } = picked;
				if (previous) {
					yield { type: "notice", message: `Troquei de ${label(previous.entry)} para ${label(entry)} porque ${reasonText(previous.reason)}.` };
				}
				tried.add(label(entry));
				const apiKey = await config.apiKeyFor(entry.provider);
				if (!apiKey) {
					failures.push({ entry, reason: "down" });
					previous = { entry, reason: "down" };
					continue;
				}

				const queue: string[] = [];
				let delivered = false;
				let outcome: { ok: true; result: Awaited<ReturnType<ProviderStreamChat>> } | { ok: false; error: unknown } | undefined;
				let wake: (() => void) | undefined;
				const merge = singleSystem ? singleSystem.has(entry.provider) : true;
				const call = config.streamChat(
					{
						messages: toLegacyMessages(req.messages, { mergeSystem: merge }),
						model: formatModelRef(entry.provider, entry.model),
						apiKey,
						tools: toLegacyTools(req.tools),
						signal: internal.signal,
						timeoutMs: timeouts.totalMs,
						progressTimeoutMs: timeouts.totalMs,
						firstEventTimeoutMs: timeouts.firstEventMs,
						idleTimeoutMs: timeouts.idleMs,
					},
					{
						onDelta: (text) => {
							queue.push(text);
							wake?.();
						},
					},
				);
				void Promise.resolve(call).then(
					(result) => {
						outcome = { ok: true, result };
						wake?.();
					},
					(error: unknown) => {
						outcome = { ok: false, error };
						wake?.();
					},
				);
				for (;;) {
					while (queue.length > 0) {
						delivered = true;
						yield { type: "text_delta", text: queue.shift() as string };
					}
					if (outcome) break;
					await new Promise<void>((res) => {
						wake = res;
					});
				}

				if (outcome.ok) {
					const { result } = outcome;
					const toolCalls: LlmToolCall[] = (result.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: parseToolArgs(c.function.arguments) }));
					for (const call of toolCalls) yield { type: "tool_call", call };
					const u = result.usage;
					const reason = result.finishReason;
					const finishReason = toolCalls.length > 0 ? "tool_calls" : reason === "length" ? "length" : reason === "stop" || reason === undefined ? "stop" : "error";
					yield {
						type: "done",
						finishReason,
						usage: {
							inputTokens: u?.promptTokens ?? 0,
							outputTokens: u?.completionTokens ?? 0,
							...(u?.cachedTokens !== undefined ? { cachedInputTokens: u.cachedTokens } : {}),
							...(u?.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
						},
						served: { provider: entry.provider, model: result.model || entry.model },
					};
					return;
				}

				const verdict = classifyFailure(outcome.error, cooldowns, req.signal);
				if (verdict.kind === "fatal") throw outcome.error;
				if (verdict.markHealth) health.mark(entry.provider, { until: config.clock.now().getTime() + verdict.cooldownMs, reason: verdict.reason });
				if (delivered) {
					// Sem emenda: o parcial fica como está e o kernel refaz o passo na próxima entrada.
					yield { type: "done", finishReason: "error", usage: ZERO_USAGE, served: { provider: entry.provider, model: entry.model } };
					return;
				}
				failures.push({ entry, reason: verdict.reason });
				previous = { entry, reason: verdict.reason };
			}
		} finally {
			req.signal?.removeEventListener("abort", onAbort);
			internal.abort();
		}
	}

	return {
		chat,
		async contextWindow(role) {
			const picked = await pick(role, new Set());
			if ("none" in picked) return 128_000;
			return config.contextWindowFor ? config.contextWindowFor(picked.entry) : 128_000;
		},
	};
}
