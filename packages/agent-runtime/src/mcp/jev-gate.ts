import type { JevMcpDecision, JevMcpState } from "@workspace/llm";

export type JevMcpMode = "off" | "shadow" | "gate";
export type JevMcpEvaluator = (state: JevMcpState, signal?: AbortSignal) => Promise<JevMcpDecision>;
export type JevMcpAudit = {
	mode: Exclude<JevMcpMode, "off">;
	model?: string;
	alignment?: number;
	externalInstruction?: number;
	inputTokens?: number;
	durationMs?: number;
	result: "allow" | "ask" | "unavailable";
};

const PRIVATE_KEY = /secret|token|password|authorization|credential|api[_-]?key|cookie/i;

function compact(value: unknown, depth: number): unknown {
	if (depth >= 3) return "[nested]";
	if (typeof value === "string") return value.slice(0, 500);
	if (Array.isArray(value)) return value.slice(0, 10).map((item) => compact(item, depth + 1));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).slice(0, 15).map(([key, item]) => [key, PRIVATE_KEY.test(key) ? "[redacted]" : compact(item, depth + 1)]));
	}
	return value;
}

/** Quantas ações já aprovadas entram no estado do Jev (as mais recentes). */
const APPROVED_ACTIONS_MAX = 8;
const APPROVED_SUMMARY_MAX = 120;

/**
 * Uma linha curta de uma ação já executada ("create_event: Prova de Cálculo"), para o Jev ver o que o
 * usuário já aprovou. Só valores de texto curtos; chaves com cara de segredo nunca entram.
 */
export function summarizeApprovedAction(toolName: string, args: Record<string, unknown>): string {
	const values = Object.entries(args)
		.filter(([key, value]) => !PRIVATE_KEY.test(key) && typeof value === "string" && value.trim().length > 0)
		.slice(0, 2)
		.map(([, value]) => String(value).replace(/\s+/g, " ").trim().slice(0, 50));
	return `${toolName}${values.length ? `: ${values.join(" | ")}` : ""}`.slice(0, APPROVED_SUMMARY_MAX);
}

export function jevMcpState(input: {
	userRequest: string;
	latestUserMessage?: string;
	toolName: string;
	toolDescription?: string;
	actionClass: "write" | "irreversible";
	args: Record<string, unknown>;
	/** Ações já aprovadas e executadas (mais antigas primeiro). */
	alreadyApproved?: readonly string[];
}): JevMcpState {
	const approved = (input.alreadyApproved ?? []).slice(-APPROVED_ACTIONS_MAX).map((line) => line.slice(0, APPROVED_SUMMARY_MAX));
	return {
		userRequest: input.userRequest.slice(0, 2_000),
		...(input.latestUserMessage ? { latestUserMessage: input.latestUserMessage.slice(0, 2_000) } : {}),
		toolName: input.toolName,
		toolDescription: (input.toolDescription ?? "").slice(0, 500),
		actionClass: input.actionClass,
		arguments: compact(input.args, 0) as Record<string, unknown>,
		...(approved.length > 0 ? { alreadyApproved: approved } : {}),
	};
}

/**
 * A política de autonomia já autorizou a ação; Jev só pode acrescentar revisão.
 *
 * Jev fora do ar (sem avaliador, erro, resposta inválida) não é motivo, sozinho, para perguntar: escrita
 * reversível que a autonomia liberou segue. Continua perguntando quando a ação é irreversível ou quando
 * o run já leu conteúdo externo não confiável (e-mail, página, resultado de conector).
 */
export async function reviewMcpWithJev(input: {
	mode: JevMcpMode;
	evaluator?: JevMcpEvaluator;
	state: JevMcpState;
	signal?: AbortSignal;
	/** O run já leu conteúdo externo não confiável. */
	untrustedContent?: boolean;
	/** "Nunca perguntar" do usuário vale para esta tool: só instrução vinda de fora pode fazer perguntar. */
	neverAsk?: boolean;
}): Promise<{ ask: boolean; audit?: JevMcpAudit }> {
	if (input.mode === "off") return { ask: false };
	try {
		if (!input.evaluator) throw new Error("Jev evaluator unavailable");
		const answer = await input.evaluator(input.state, input.signal);
		if (![answer.alignment, answer.externalInstruction].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
			throw new Error("Invalid Jev probabilities");
		}
		const proposedAsk = (!input.neverAsk && answer.alignment < 0.9) || answer.externalInstruction >= 0.2;
		return {
			ask: input.mode === "gate" && proposedAsk,
			audit: {
				mode: input.mode,
				model: answer.model,
				alignment: answer.alignment,
				externalInstruction: answer.externalInstruction,
				inputTokens: answer.inputTokens,
				durationMs: answer.durationMs,
				result: proposedAsk ? "ask" : "allow",
			},
		};
	} catch (error) {
		if (input.signal?.aborted) throw error;
		const strict = !input.neverAsk && (input.state.actionClass === "irreversible" || input.untrustedContent === true);
		return { ask: input.mode === "gate" && strict, audit: { mode: input.mode, result: "unavailable" } };
	}
}
