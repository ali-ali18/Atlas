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

export function jevMcpState(input: {
	userRequest: string;
	latestUserMessage?: string;
	toolName: string;
	toolDescription?: string;
	actionClass: "write" | "irreversible";
	args: Record<string, unknown>;
}): JevMcpState {
	return {
		userRequest: input.userRequest.slice(0, 2_000),
		...(input.latestUserMessage ? { latestUserMessage: input.latestUserMessage.slice(0, 2_000) } : {}),
		toolName: input.toolName,
		toolDescription: (input.toolDescription ?? "").slice(0, 500),
		actionClass: input.actionClass,
		arguments: compact(input.args, 0) as Record<string, unknown>,
	};
}

/** A política de autonomia já autorizou a ação; Jev só pode acrescentar revisão. */
export async function reviewMcpWithJev(input: {
	mode: JevMcpMode;
	evaluator?: JevMcpEvaluator;
	state: JevMcpState;
	signal?: AbortSignal;
}): Promise<{ ask: boolean; audit?: JevMcpAudit }> {
	if (input.mode === "off") return { ask: false };
	try {
		if (!input.evaluator) throw new Error("Jev evaluator unavailable");
		const answer = await input.evaluator(input.state, input.signal);
		if (![answer.alignment, answer.externalInstruction].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
			throw new Error("Invalid Jev probabilities");
		}
		const proposedAsk = answer.alignment < 0.9 || answer.externalInstruction >= 0.2;
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
		return { ask: input.mode === "gate", audit: { mode: input.mode, result: "unavailable" } };
	}
}
