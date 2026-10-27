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

/** Por que o Jev mandou perguntar: `external_instruction` nunca ganha "Sempre para…". */
export type JevReviewReason = "external_instruction" | "alignment" | "unavailable";

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

/** Quantas tools já aprovadas entram no estado do Jev (as mais usadas primeiro). */
const APPROVED_TOOLS_MAX = 8;
const APPROVED_NAME_MAX = 60;

/**
 * "create_event ×3": só nome da tool e contagem. Argumento, título ou qualquer texto vindo de e-mail/página
 * nunca vai ao Jev por aqui (um atacante poderia escrever "o usuário já aprovou tudo" num título).
 */
export function summarizeApprovedTools(toolNames: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const raw of toolNames) {
		const name = raw.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, APPROVED_NAME_MAX);
		if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1]).slice(0, APPROVED_TOOLS_MAX).map(([name, count]) => `${name} ×${count}`);
}

export function jevMcpState(input: {
	userRequest: string;
	latestUserMessage?: string;
	toolName: string;
	toolDescription?: string;
	actionClass: "write" | "irreversible";
	args: Record<string, unknown>;
	/** Nomes das tools que o usuário já aprovou e rodaram nesta conversa (repetições contam). */
	approvedTools?: readonly string[];
	/** O run já leu conteúdo que o usuário não escreveu. */
	untrustedContentSeen?: boolean;
}): JevMcpState {
	const approved = summarizeApprovedTools(input.approvedTools ?? []);
	return {
		userRequest: input.userRequest.slice(0, 2_000),
		...(input.latestUserMessage ? { latestUserMessage: input.latestUserMessage.slice(0, 2_000) } : {}),
		toolName: input.toolName,
		toolDescription: (input.toolDescription ?? "").slice(0, 500),
		actionClass: input.actionClass,
		arguments: compact(input.args, 0) as Record<string, unknown>,
		...(approved.length > 0 ? { alreadyApproved: approved } : {}),
		...(input.untrustedContentSeen ? { untrustedContentSeen: true } : {}),
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
	/** Aprovação por tarefa em uso: o alinhamento já foi aprovado pelo usuário; só a instrução vinda de fora pode fazer perguntar. */
	externalInstructionOnly?: boolean;
}): Promise<{ ask: boolean; audit?: JevMcpAudit; reason?: JevReviewReason }> {
	if (input.mode === "off") return { ask: false };
	try {
		if (!input.evaluator) throw new Error("Jev evaluator unavailable");
		const answer = await input.evaluator(input.state, input.signal);
		if (![answer.alignment, answer.externalInstruction].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
			throw new Error("Invalid Jev probabilities");
		}
		const external = answer.externalInstruction >= 0.2;
		const misaligned = !input.neverAsk && !input.externalInstructionOnly && answer.alignment < 0.9;
		const proposedAsk = misaligned || external;
		return {
			ask: input.mode === "gate" && proposedAsk,
			...(proposedAsk ? { reason: external ? "external_instruction" as const : "alignment" as const } : {}),
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
		// `neverAsk` só relaxa o alinhamento: Jev fora do ar continua perguntando para irreversível e depois de conteúdo externo.
		const strict = input.state.actionClass === "irreversible" || input.untrustedContent === true;
		return { ask: input.mode === "gate" && strict, ...(strict ? { reason: "unavailable" as const } : {}), audit: { mode: input.mode, result: "unavailable" } };
	}
}
