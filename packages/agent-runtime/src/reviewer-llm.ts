import { recordMaintenanceResult } from "@workspace/db";
import {
	jevMcpQuestions,
	JEV_MCP_TIMEOUT_MS,
	askJev,
	askJevViaChat,
	completeChat,
	mcpDecisionFromAnswers,
	type JevMcpDecision,
	type JevMcpState,
	type ProviderStreamChat,
} from "@workspace/llm";
import { MAINTENANCE_NO_KEY_MESSAGE, buildMaintenanceCandidates, isMaintenanceFallbackError, type AccountConfigV1, type MaintenanceCandidate } from "@workspace/shared";
import type { JevAsk, JevComplete } from "./jev/decide.js";
import { createKeyProviderStreams, resolveMaintenanceCandidates, type MaintenanceBootConfig, type MaintenanceLlmDeps } from "./maintenance-llm.js";
import { apiKeyService } from "./providers/api-key-service.js";
import { getAccountConfig } from "@workspace/db";

/** Modelo rápido do Verificador de ações (OpenRouter) quando o revisor não foi escolhido. */
export const REVIEWER_JUDGE_MODEL_DEFAULT = "anthropic/claude-haiku-5.5";

type Attempt = { kind: "native" } | { kind: "chat"; candidate: MaintenanceCandidate };

export type ReviewerLlmDeps = MaintenanceLlmDeps & {
	askJev?: typeof askJev;
	/** Instante atual (ms), só para o limitador do diagnóstico. */
	now?: () => number;
};

export type ReviewerClient = {
	/** Há pelo menos um caminho (Jev nativo, modelo escolhido ou cadeia da manutenção)? */
	available: boolean;
	ask: JevAsk;
	complete: JevComplete;
	evaluateMcp: (state: JevMcpState, signal?: AbortSignal) => Promise<JevMcpDecision>;
};

const REPORT_EVERY_MS = 5 * 60_000;
const lastReport = new Map<string, number>();

/**
 * Cliente do revisor (Jev). Ordem: modelo escolhido em `models.reviewer` > Jev fixo no OpenRouter (se o servidor tem a
 * chave) > cadeia da manutenção. Em erro de política/disponibilidade troca UMA vez para o próximo caminho.
 * Os tempos limite são os de cada decisão (quem chama). Erro final propaga: o chamador mantém o fail-safe.
 */
export async function createReviewerClient(
	input: { userId?: string; config: MaintenanceBootConfig; judgeModel?: string },
	deps: ReviewerLlmDeps = {},
): Promise<ReviewerClient> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const hasKey = deps.hasKey ?? (async (userId, provider) => (await apiKeyService.status(userId, provider)).status === "connected");
	const doChat = deps.completeChat ?? completeChat;
	const doAskJev = deps.askJev ?? askJev;
	const orKey = input.config.openRouterApiKey;
	const judgeModel = input.judgeModel ?? REVIEWER_JUDGE_MODEL_DEFAULT;

	let lists: { ask: Attempt[]; complete: Attempt[] } | null = null;
	const load = async () => {
		if (lists) return lists;
		let account: AccountConfigV1 | null = null;
		const keys = { openrouter: Boolean(orKey), anthropic: false, "opencode-go": false };
		if (input.userId) {
			account = await (deps.loadConfig ?? getAccountConfig)(input.userId).catch(() => null);
			keys.anthropic = await hasKey(input.userId, "anthropic").catch(() => false);
			keys["opencode-go"] = await hasKey(input.userId, "opencode-go").catch(() => false);
		}
		const chosen = buildMaintenanceCandidates({ chosen: account?.models?.reviewer, keys }).map((candidate): Attempt => ({ kind: "chat", candidate }));
		const chain = input.userId ? (await resolveMaintenanceCandidates({ kind: "reviewer", config: input.config, userId: input.userId }, deps)).candidates : [];
		const chainAttempts = chain.map((candidate): Attempt => ({ kind: "chat", candidate }));
		const judge: Attempt[] = orKey ? [{ kind: "chat", candidate: { model: judgeModel, provider: "openrouter", role: "server-default" } }] : [];
		lists = {
			ask: [...chosen, ...(orKey ? [{ kind: "native" } as Attempt] : []), ...chainAttempts],
			complete: [...chosen, ...judge, ...chainAttempts],
		};
		return lists;
	};
	const available = Boolean(orKey) || (await load()).ask.length > 0;

	const streams = input.userId ? (deps.streams ?? ((userId: string) => createKeyProviderStreams({ userId })))(input.userId) : null;
	const viaFor = (c: MaintenanceCandidate): ProviderStreamChat | undefined => (c.provider === "anthropic" ? streams?.anthropic : c.provider === "opencode-go" ? streams?.opencodeGo : undefined);

	const report = (ok: boolean, error?: unknown) => {
		if (!input.userId) return;
		const key = `${input.userId}|${ok}`;
		const now = (deps.now ?? Date.now)();
		if (now - (lastReport.get(key) ?? 0) < REPORT_EVERY_MS) return;
		lastReport.set(key, now);
		void (deps.record ?? recordMaintenanceResult)(input.userId, "reviewer", ok ? { ok: true } : { ok: false, error }).catch(() => undefined);
	};

	function runner(pick: (l: NonNullable<typeof lists>) => Attempt[]) {
		let active = 0;
		let switched = false;
		return async function run<T>(call: (attempt: Attempt) => Promise<T>): Promise<T> {
			const attempts = pick(await load());
			const first = attempts[active];
			if (!first) throw new Error(MAINTENANCE_NO_KEY_MESSAGE);
			try {
				const result = await call(first);
				report(true);
				return result;
			} catch (error) {
				const next = attempts[active + 1];
				if (switched || !next || !isMaintenanceFallbackError(error)) {
					report(false, error);
					throw error;
				}
				switched = true;
				active += 1;
				const label = (a: Attempt) => (a.kind === "native" ? "jev-nativo" : a.candidate.model);
				log(`[reviewer] ${label(first)} falhou (${error instanceof Error ? error.name : "erro"}); usando ${label(next)}`);
				try {
					const result = await call(next);
					report(true);
					return result;
				} catch (second) {
					report(false, second);
					throw second;
				}
			}
		};
	}
	const runAsk = runner((l) => l.ask);
	const runComplete = runner((l) => l.complete);

	const ask: JevAsk = (request) =>
		runAsk((attempt) =>
			attempt.kind === "native"
				? doAskJev({ apiKey: orKey!, state: request.state, questions: request.questions, timeoutMs: request.timeoutMs, signal: request.signal })
				: askJevViaChat({
						model: attempt.candidate.model,
						apiKey: attempt.candidate.provider === "openrouter" ? (orKey ?? "") : "",
						state: request.state,
						questions: request.questions,
						timeoutMs: request.timeoutMs,
						signal: request.signal,
						via: viaFor(attempt.candidate),
						complete: doChat,
					}),
		);

	const complete: JevComplete = (request) =>
		runComplete(async (attempt) => {
			if (attempt.kind === "native") throw new Error("unreachable");
			const via = viaFor(attempt.candidate);
			const result = await doChat({
				model: attempt.candidate.model,
				apiKey: attempt.candidate.provider === "openrouter" ? (orKey ?? "") : "",
				messages: [
					{ role: "system", content: request.system },
					{ role: "user", content: request.user },
				],
				timeoutMs: request.timeoutMs,
				signal: request.signal,
				...(via ? { via } : {}),
			});
			return result.message.content;
		});

	const evaluateMcp = async (state: JevMcpState, signal?: AbortSignal): Promise<JevMcpDecision> =>
		mcpDecisionFromAnswers(await ask({ state, questions: jevMcpQuestions(state.untrustedContentSeen === true), timeoutMs: JEV_MCP_TIMEOUT_MS, signal }));

	return { available, ask, complete, evaluateMcp };
}
