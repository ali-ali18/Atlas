import { formatModelRef, pickModelFor } from "@workspace/shared";
import type { ModelChainEntry, ModelProvider, NoModelReason, ProviderHealthReason, RoleChains, SpendCeilings, SpendSoFar } from "@workspace/shared";
import type { ProviderStreamChat } from "@workspace/llm";
import { copyFor } from "../../copy/index.js";
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
	/** Provedores que exigem papéis alternados: `user` seguidos são fundidos na requisição (`mergeConsecutiveUser`). Padrão: todos. */
	mergeUserProviders?: readonly ModelProvider[];
	/** Idioma do bot, para os textos que o dono lê (aviso de troca, motivo de indisponibilidade). Padrão: pt-BR. */
	language?: unknown;
	contextWindowFor?: (entry: ModelChainEntry) => number | Promise<number>;
};

/** Nenhuma entrada utilizável na cadeia (tudo fora do ar, sem cadeia ou teto do dono). Carrega o motivo real. */
export class LlmUnavailableError extends Error {
	readonly reason: NoModelReason;
	constructor(reason: NoModelReason, language?: unknown) {
		super(describeNone(reason, language));
		this.name = "LlmUnavailableError";
		this.reason = reason;
	}
}

export function describeNone(reason: NoModelReason, language?: unknown): string {
	switch (reason.kind) {
		case "no_chain":
			return copyFor(language, "model_none");
		case "ceiling": {
			const source = copyFor(language, reason.source === "bot" ? "ceiling_of_bot" : "ceiling_of_account");
			const period = copyFor(language, ({ day: "ceiling_day", week: "ceiling_week", month: "ceiling_month" } as const)[reason.period]);
			// Sempre em dólares (USD): é a moeda em que os provedores cobram e em que o teto foi configurado.
			return copyFor(language, "spend_ceiling", { period, source, spent: reason.spentUsd.toFixed(2), limit: reason.limitUsd.toFixed(2) });
		}
		default:
			return copyFor(language, "models_unavailable", { details: reason.skipped.map((s) => `${label(s.entry)} (${reasonText(s.reason, language)})`).join("; ") });
	}
}

const label = (e: ModelChainEntry) => `${e.provider}/${e.model}`;
const resolve = async <T>(v: T | (() => T | Promise<T>)): Promise<T> => (typeof v === "function" ? (v as () => T | Promise<T>)() : v);
const DEFAULT_CONTEXT_WINDOW = 128_000;
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

	const mergeUserSet = config.mergeUserProviders ? new Set<ModelProvider>(config.mergeUserProviders) : undefined;

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
						throw new LlmUnavailableError({ kind: "all_unavailable", skipped: [...extra, ...picked.none.skipped] }, config.language);
					}
					throw new LlmUnavailableError(picked.none, config.language);
				}
				const { entry } = picked;
				if (previous) {
					yield { type: "notice", message: copyFor(config.language, "model_switched", { from: label(previous.entry), to: label(entry), reason: reasonText(previous.reason, config.language) }) };
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
				// `new Promise` captura também o throw SÍNCRONO do roteador (chave ausente, schema inválido): ele passa por
				// `classifyFailure` como qualquer outra falha, em vez de escapar do laço da cadeia.
				const call = new Promise<Awaited<ReturnType<ProviderStreamChat>>>((resolveCall) => resolveCall(config.streamChat(
					{
						messages: toLegacyMessages(req.messages, { mergeSystem: merge, mergeUser: mergeUserSet ? mergeUserSet.has(entry.provider) : true }),
						model: formatModelRef(entry.provider, entry.model),
						apiKey,
						tools: toLegacyTools(req.tools),
						// "none" no passo final: as tools seguem no pedido (prefixo/cache estáveis), mas o provedor não as aceita como chamada.
						...(req.toolChoice ? { toolChoice: req.toolChoice } : {}),
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
				)));
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
				// Cadeia de UMA entrada: não há para onde trocar, e pôr o único provedor em quarentena faria o retry de transporte
				// do kernel (que chama `chat` de novo) falhar na hora com "tudo indisponível". Sem quarentena o retry tenta a mesma entrada.
				const soleEntry = ((await resolve(config.chains))[req.role]?.length ?? 0) <= 1;
				if (verdict.markHealth && !soleEntry) health.mark(entry.provider, { until: config.clock.now().getTime() + verdict.cooldownMs, reason: verdict.reason });
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

	// Última janela conhecida por papel: com a entrada em quarentena ou a consulta de capacidades falhando, a compactação
	// segue com o valor real em vez de cair para 128k (que dispararia compactação cedo demais ou tarde demais).
	const lastWindow = new Map<LlmRole, number>();
	return {
		chat,
		async contextWindow(role) {
			const remembered = lastWindow.get(role) ?? DEFAULT_CONTEXT_WINDOW;
			const picked = await pick(role, new Set()).catch(() => ({ none: { kind: "no_chain" } }) as const);
			if ("none" in picked || !config.contextWindowFor) return remembered;
			try {
				const window = await config.contextWindowFor(picked.entry);
				if (!Number.isFinite(window) || window <= 0) return remembered;
				lastWindow.set(role, window);
				return window;
			} catch {
				return remembered;
			}
		},
	};
}
