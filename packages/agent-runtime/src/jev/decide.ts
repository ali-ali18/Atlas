import type { JevAnswers, JevQuestion } from "@workspace/llm";
import { redactSecrets } from "../mcp/sanitize.js";

/**
 * Decisões baratas com o Jev (F11). Um único ponto para: modo por item
 * (`off|shadow|on`), timeout, fail-safe, redação/truncamento e log de depuração.
 * Regra de ouro: erro, timeout ou resposta malformada = `null` = comportamento de hoje.
 */

export type JevFeature = "intent" | "tools" | "verify" | "blockpage" | "delegate" | "stuck" | "proactive" | "pending" | "actions" | "memory";
export type JevFeatureMode = "off" | "shadow" | "on";

export type JevAsk = (request: {
	state: unknown;
	questions: Record<string, JevQuestion>;
	timeoutMs: number;
	signal?: AbortSignal;
}) => Promise<JevAnswers>;

export type JevDecisionRecord = {
	feature: JevFeature;
	mode: Exclude<JevFeatureMode, "off">;
	source: "jev" | "heuristic" | "unavailable";
	answers?: Record<string, number>;
	durationMs?: number;
	model?: string;
	/** Tokens de entrada informados pelo Jev (custo não é informado). */
	inputTokens?: number;
};

/** Chamada de texto ao modelo rápido (Verificador de ações). Devolve o texto cru da resposta. */
export type JevComplete = (request: { system: string; user: string; timeoutMs: number; signal?: AbortSignal }) => Promise<string>;

export type JevRuntime = {
	ask?: JevAsk;
	/** Resposta em texto do modelo rápido; só o Verificador de ações (`actions`) usa. */
	complete?: JevComplete;
	modes?: Partial<Record<JevFeature, JevFeatureMode>>;
	/** Registro de cada decisão (shadow e on), sem conteúdo do usuário. */
	onDecision?: (record: JevDecisionRecord) => void;
};

export const JEV_FEATURE_TIMEOUT_MS: Record<JevFeature, number> = {
	intent: 2_500,
	tools: 2_500,
	verify: 3_000,
	blockpage: 2_000,
	delegate: 2_500,
	stuck: 2_000,
	proactive: 3_000,
	pending: 4_000,
	actions: 8_000,
	memory: 3_000,
};

export function parseJevFeatureMode(raw: string | undefined): JevFeatureMode {
	const value = raw?.trim().toLowerCase();
	return value === "shadow" || value === "on" ? value : "off";
}

export function jevModeFor(rt: JevRuntime | undefined, feature: JevFeature): JevFeatureMode {
	if (!rt?.ask) return "off";
	return rt.modes?.[feature] ?? "off";
}

/**
 * O mesmo runtime com `feature` rebaixada de `on` para `shadow`: a decisão roda e é registrada (`onDecision`), mas
 * quem chama não age sobre ela. Usado nos juízes que não podem descartar uma resposta final completa.
 */
export function observeOnly(rt: JevRuntime | undefined, feature: JevFeature): JevRuntime | undefined {
	if (!rt || jevModeFor(rt, feature) !== "on") return rt;
	return { ...rt, modes: { ...rt.modes, [feature]: "shadow" } };
}

/** Redige segredos e corta: nada vai inteiro ao Jev. */
export function clipForJev(text: string, max: number): string {
	return redactSecrets(text).slice(0, max);
}

/** Probabilidade "sim" acima do limite. */
export function jevYes(probability: number | undefined, threshold = 0.8): boolean {
	return typeof probability === "number" && Number.isFinite(probability) && probability >= threshold;
}

function record(rt: JevRuntime, entry: JevDecisionRecord): void {
	try {
		rt.onDecision?.(entry);
		if (process.env[`JEV_${entry.feature.toUpperCase()}_DEBUG`] === "1") {
			console.info(`[jev:${entry.feature}] ${JSON.stringify(entry)}`);
		}
	} catch {
		// telemetria nunca derruba o run
	}
}

export function recordHeuristic(rt: JevRuntime | undefined, feature: JevFeature): void {
	const mode = jevModeFor(rt, feature);
	if (rt && mode !== "off") record(rt, { feature, mode, source: "heuristic" });
}

/**
 * Uma chamada ao Jev com timeout e fail-safe. Devolve `null` quando o item está
 * `off`, sem cliente, ou quando a chamada falha. O cancelamento do usuário propaga.
 */
export async function decideWithJev(input: {
	rt: JevRuntime | undefined;
	feature: JevFeature;
	state: unknown;
	questions: Record<string, JevQuestion>;
	signal?: AbortSignal;
}): Promise<JevAnswers | null> {
	const { rt, feature } = input;
	const mode = jevModeFor(rt, feature);
	if (!rt?.ask || mode === "off") return null;
	const timeoutMs = JEV_FEATURE_TIMEOUT_MS[feature];
	const startedAt = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Jev timeout")), timeoutMs + 250);
		});
		const answers = await Promise.race([
			rt.ask({ state: input.state, questions: input.questions, timeoutMs, signal: input.signal }),
			timeout,
		]);
		for (const key of Object.keys(input.questions)) {
			const value = answers.answers?.[key];
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
				throw new Error("Invalid Jev answer");
			}
		}
		record(rt, { feature, mode, source: "jev", answers: answers.answers, durationMs: answers.durationMs, model: answers.model, ...(answers.inputTokens !== undefined ? { inputTokens: answers.inputTokens } : {}) });
		return answers;
	} catch (error) {
		if (input.signal?.aborted) throw error;
		record(rt, { feature, mode, source: "unavailable", durationMs: Date.now() - startedAt });
		return null;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
