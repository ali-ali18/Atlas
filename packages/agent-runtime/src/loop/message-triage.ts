import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { RunUsage } from "@workspace/shared";
import { DELIVERY_DEFAULT_TIMEZONE, wallClockNow } from "@workspace/shared";
import { modelUsage } from "../telemetry/model-usage.js";

/**
 * Triagem de mensagem do usuário com o run ativo (join/steer). Uma chamada
 * pequena e separada por ingestão decide o que a mensagem significa (conversa,
 * mudança/cancelamento, pedido para depois) e já escreve a resposta visível.
 * O agente decide, não regex nem escolha de modo na UI. Nunca derruba o run:
 * falha, timeout ou JSON inválido devolvem `null` e o chamador cai no cabeçalho neutro.
 */

export const MESSAGE_TRIAGE_TIMEOUT_MS = 10_000;
export const MESSAGE_TRIAGE_MAX_OUTPUT_TOKENS = 120;
const OBJECTIVE_MAX_CHARS = 300;
const PROGRESS_MAX_CHARS = 200;
const MESSAGE_MAX_CHARS = 1_500;
const REPLY_MAX_CHARS = 500;
const INSTRUCTION_MAX_CHARS = 600;

export type TriageKind = "chat" | "change" | "later";

export type MessageTriage = {
	kind: TriageKind;
	cancel: boolean;
	reply: string;
	instruction: string;
	/** A tarefa nova (change/later) exige um arquivo como entrega. Ausente no JSON = false. */
	wantsFile?: boolean;
	/** O usuário avisou que vai sair e espera o resultado depois (entrega offline). Ausente = false. */
	away?: boolean;
	/** Horário combinado para o aviso (ISO 8601 de parede, sem fuso); vazio = quando o run terminar. */
	deliverAt?: string;
};
const DELIVER_AT_MAX_CHARS = 40;

export type TriageStreamChat = (params: CompleteChatWithToolsParams) => Promise<CompleteChatWithToolsResult>;

export const MESSAGE_TRIAGE_SYSTEM = [
	"The user sent a message while you work on a task.",
	"Classify it: chat = small talk or a comment that does not change the task; change = the user changes, narrows, or cancels the current task; later = a request to do something after the current task.",
	"Write a short reply: for chat respond naturally and say you are continuing; for change confirm the new direction; for later confirm you will do it after finishing.",
	"For change, instruction is the full updated task; for later, instruction is what to do afterwards; otherwise leave it empty. Set cancel to true only if the user wants to stop the task.",
	"Set wantsFile to true only if the new or later task asks for a file as its deliverable (for example a PDF, spreadsheet or document); otherwise false.",
	"Set away to true only if the user says they are leaving or will check back later and expects the result then; otherwise false.",
	"If away is true and the user names a time to be notified, set deliverAt to that local time as ISO 8601 without offset (for example 2026-01-31T07:00), computed from Current local time; otherwise leave it empty.",
	'Output JSON only: {"kind":"chat|change|later","cancel":true|false,"reply":"...","instruction":"...","wantsFile":true|false,"away":true|false,"deliverAt":"..."}',
].join("\n");

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Falas anteriores da conversa neste run (usuário e agente), para a triagem entender "mas eu falei do X". */
export type TriageHistoryEntry = { role: "user" | "assistant"; text: string };
const HISTORY_MAX_ENTRIES = 6;
const HISTORY_ENTRY_MAX_CHARS = 200;

export function buildTriageMessages(input: {
	objective: string;
	history?: TriageHistoryEntry[];
	progress?: string;
	message: string;
	languageInstruction: string;
	now?: Date;
	timezone?: string;
}) {
	const lines = [`Task: ${oneLine(input.objective, OBJECTIVE_MAX_CHARS)}`];
	if (input.now) {
		lines.push(`Current local time: ${wallClockNow(input.now, input.timezone ?? DELIVERY_DEFAULT_TIMEZONE)}`);
	}
	const history = (input.history ?? []).slice(-HISTORY_MAX_ENTRIES);
	if (history.length > 0) {
		lines.push(
			"Earlier in this task (oldest first):",
			...history.map((entry) => `${entry.role === "user" ? "User" : "You"}: ${oneLine(entry.text, HISTORY_ENTRY_MAX_CHARS)}`),
		);
	}
	if (input.progress) lines.push(`Progress: ${oneLine(input.progress, PROGRESS_MAX_CHARS)}`);
	lines.push(`User message:\n${input.message.trim().slice(0, MESSAGE_MAX_CHARS)}`);
	return [
		{ role: "system" as const, content: `${MESSAGE_TRIAGE_SYSTEM}\n${input.languageInstruction}` },
		{ role: "user" as const, content: lines.join("\n") },
	];
}

/** Validação estrita: só o formato pedido; qualquer desvio = `null`. */
export function parseMessageTriage(raw: string | null | undefined): MessageTriage | null {
	if (!raw) return null;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let data: unknown;
	try {
		data = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const record = data as Record<string, unknown>;
	const { kind, cancel, reply, instruction, wantsFile, away, deliverAt } = record;
	if (kind !== "chat" && kind !== "change" && kind !== "later") return null;
	if (typeof cancel !== "boolean") return null;
	if (typeof reply !== "string") return null;
	if (instruction !== undefined && typeof instruction !== "string") return null;
	if (wantsFile !== undefined && typeof wantsFile !== "boolean") return null;
	if (away !== undefined && typeof away !== "boolean") return null;
	if (deliverAt !== undefined && typeof deliverAt !== "string") return null;
	const cleanReply = oneLine(reply, REPLY_MAX_CHARS);
	const cleanInstruction = oneLine(instruction ?? "", INSTRUCTION_MAX_CHARS);
	if (!cleanReply) return null;
	if (cancel && kind !== "change") return null;
	// A instrução é o que o agente vai executar: change sem cancel e later precisam dela.
	if (kind === "later" && !cleanInstruction) return null;
	if (kind === "change" && !cancel && !cleanInstruction) return null;
	const cleanDeliverAt = away === true ? oneLine(deliverAt ?? "", DELIVER_AT_MAX_CHARS) : "";
	return {
		kind,
		cancel,
		reply: cleanReply,
		instruction: cleanInstruction,
		wantsFile: wantsFile === true,
		...(away === true ? { away: true, deliverAt: cleanDeliverAt } : {}),
	};
}

export type MessageTriageResult = { triage: MessageTriage; usage: RunUsage };

/** Classifica e responde. `null` = sem veredito (cai no cabeçalho neutro). */
export async function triageUserMessage(input: {
	streamChat: TriageStreamChat;
	model: string;
	apiKey: string;
	objective: string;
	history?: TriageHistoryEntry[];
	progress?: string;
	message: string;
	languageInstruction: string;
	now?: Date;
	timezone?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<MessageTriageResult | null> {
	const timeoutMs = input.timeoutMs ?? MESSAGE_TRIAGE_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const call = input.streamChat({
			messages: buildTriageMessages(input),
			model: input.model,
			apiKey: input.apiKey,
			tools: [],
			toolChoice: "none",
			signal,
			timeoutMs,
			maxOutputTokens: MESSAGE_TRIAGE_MAX_OUTPUT_TOKENS,
		});
		// Corrida com o prazo: um streamChat que ignore o signal não pode segurar o run.
		const deadline = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		call.catch(() => undefined);
		const result = await Promise.race([call, deadline]);
		if (result === "timeout") return null;
		const triage = parseMessageTriage(result.message.content);
		return triage ? { triage, usage: modelUsage(result) } : null;
	} catch {
		// Só metadados: o erro pode carregar trecho da conversa.
		return null;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
