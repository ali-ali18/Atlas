/**
 * Trajetória de uma execução de cenário: tudo o que o modelo recebeu e fez, gravado em JSONL para diagnóstico.
 * Nunca guarda a chave da API (o `apiKey` dos pedidos é removido antes de gravar).
 */

export type RecordedModelCall = {
	index: number;
	/** `main` = passo do agente (com tools); `aux` = chamada barata sem tools (verificações, triagem, juiz). */
	kind: "main" | "aux";
	model: string;
	messages: unknown[];
	tools: string[];
	response?: { content: string | null; toolCalls?: Array<{ name: string; arguments: string }> };
	finishReason?: string;
	usage?: { promptTokens?: number; completionTokens?: number; costUsd?: number; costUnknown?: boolean };
	durationMs: number;
	error?: string;
};

export type RecordedToolCall = { id: string; name: string; args: Record<string, unknown>; argsRaw: string; step?: number };
export type RecordedToolResult = { id: string; name: string; ok: boolean; summary: string; source: "fixture" | "connector" | "real" | "unmocked" };

export type Trajectory = {
	scenarioId: string;
	model: string;
	variant: string;
	repeat: number;
	startedAt: string;
	durationMs: number;
	text: string;
	error?: string;
	timedOut?: boolean;
	modelCalls: RecordedModelCall[];
	toolCalls: RecordedToolCall[];
	toolResults: RecordedToolResult[];
	events: Array<Record<string, unknown>>;
	/** Balões visíveis no chat (sem os rascunhos revisados). */
	visible: string[];
	revised: Array<{ text: string; reason: string }>;
	discards: string[];
	steerDelivered: string[];
	/** Tools chamadas pelo modelo sem fixture (resposta neutra de indisponível): lacuna do cenário. */
	unmocked: string[];
	costUsd: number;
	costUnknown: boolean;
	tokens: { prompt: number; completion: number };
};

export type CheckResult = { name: string; pass: boolean; detail?: string; skipped?: boolean };

export type RunRecord = {
	scenarioId: string;
	model: string;
	variant: string;
	repeat: number;
	pass: boolean;
	checks: CheckResult[];
	trajectory: Trajectory;
};

/** Tools oferecidas ao modelo em qualquer passo (para achar nomes vazados no texto). */
export function offeredTools(trajectory: Pick<Trajectory, "modelCalls">): string[] {
	return [...new Set(trajectory.modelCalls.filter((call) => call.kind === "main").flatMap((call) => call.tools))];
}

export const mainCalls = (trajectory: Pick<Trajectory, "modelCalls">): RecordedModelCall[] => trajectory.modelCalls.filter((call) => call.kind === "main");
