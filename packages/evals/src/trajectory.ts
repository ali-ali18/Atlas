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
	/** Tamanho (caracteres do JSON) dos schemas das tools oferecidas: entra na estimativa de contexto do 1º passo. */
	toolsChars?: number;
	response?: { content: string | null; toolCalls?: Array<{ name: string; arguments: string }> };
	finishReason?: string;
	usage?: { promptTokens?: number; completionTokens?: number; costUsd?: number; costUnknown?: boolean };
	durationMs: number;
	error?: string;
	/** `name` do erro lançado pelo provedor/runtime (ex.: `TimeoutError`, de `DOMException`): classificação sem ler texto. */
	errorName?: string;
};

export type RecordedToolCall = { id: string; name: string; args: Record<string, unknown>; argsRaw: string; step?: number };
export type RecordedToolResult = { id: string; name: string; ok: boolean; summary: string; source: "fixture" | "connector" | "real" | "unmocked" };

/** Arquivo criado no run (via `create_file`): nome, tipo e, quando é texto, o conteúdo (até `FILE_TEXT_LIMIT` caracteres). */
export type RecordedFile = { artifactId: string; filename: string; mime: string; size: number; text?: string; textOmitted?: number };

export type Trajectory = {
	scenarioId: string;
	model: string;
	variant: string;
	repeat: number;
	startedAt: string;
	durationMs: number;
	text: string;
	/** Por que o run terminou (motivo e detalhe do runtime), quando ele devolve. */
	stop?: { reason: string; detail?: string };
	error?: string;
	/** `name` do erro que encerrou o run (ver `RecordedModelCall.errorName`). */
	errorName?: string;
	timedOut?: boolean;
	modelCalls: RecordedModelCall[];
	toolCalls: RecordedToolCall[];
	toolResults: RecordedToolResult[];
	events: Array<Record<string, unknown>>;
	/** Arquivos criados com o conteúdo (texto) que o juiz precisa ler; ausente em trajetórias antigas. */
	files?: RecordedFile[];
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

export type CheckResult = {
	name: string;
	pass: boolean;
	detail?: string;
	skipped?: boolean;
	/** Notas da rubrica de qualidade (só na verificação `judge`, com `--judge`). */
	quality?: import("./quality.js").QualityResult;
};

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
