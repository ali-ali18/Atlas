import type { SerializedLlmMessage } from "@workspace/shared";
import { COMPACTION_NOTE_PREFIX } from "./budget.js";
import { SUMMARY_NOTE_PREFIX } from "./summary-compaction.js";

/**
 * Conversa contínua entre turnos: o run novo parte das mensagens do LLM do run anterior da conversa
 * (chamadas e resultados de ferramenta), não só do texto. Aqui só há funções puras: limpar a conversa
 * gravada, conferir por id se ela ainda corresponde à conversa do banco e encaixar o resultado de uma
 * aprovação na chamada que ficou pendente. Qualquer dúvida devolve `null` e o chamador usa o
 * histórico de texto de sempre.
 */

/** Resultado colocado numa chamada que ficou sem resposta (run cancelado ou parado antes de executá-la). */
export const UNEXECUTED_CALL_RESULT = "[not executed: the turn ended before this call ran]";

const ROLES = new Set(["system", "user", "assistant", "tool"]);

/** Texto de uma mensagem (string ou primeira parte de texto). */
export function transcriptTextOf(message: { content: SerializedLlmMessage["content"] }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const first = message.content.find((part) => part.type === "text");
	return first && first.type === "text" ? first.text : "";
}

function isLayerNote(message: SerializedLlmMessage): boolean {
	return (
		message.role === "system" &&
		typeof message.content === "string" &&
		(message.content.startsWith(SUMMARY_NOTE_PREFIX) || message.content.startsWith(COMPACTION_NOTE_PREFIX))
	);
}

function validShape(message: unknown): message is SerializedLlmMessage {
	if (!message || typeof message !== "object") return false;
	const { role, content, tool_calls: toolCalls, tool_call_id: toolCallId } = message as Record<string, unknown>;
	if (typeof role !== "string" || !ROLES.has(role)) return false;
	if (content !== null && typeof content !== "string" && !Array.isArray(content)) return false;
	if (toolCalls !== undefined && !Array.isArray(toolCalls)) return false;
	if (role === "tool" && typeof toolCallId !== "string") return false;
	return true;
}

/**
 * Deixa só o que vale levar para o turno seguinte: tira os system (identidade, memória, notas do turno são
 * montados de novo a cada run), mantém as notas de resumo/compactação, dá resposta a chamadas sem resultado e
 * descarta resultados órfãos. `providerItems` só ficam se o modelo for o mesmo. `null` = gravação corrompida.
 */
export function cleanTranscript(raw: unknown, options: { model?: string } = {}): SerializedLlmMessage[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	if (!raw.every(validShape)) return null;
	const messages = (raw as SerializedLlmMessage[]).filter((message) => message.role !== "system" || isLayerNote(message));
	const out: SerializedLlmMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {
		const message = messages[i]!;
		if (message.role === "tool") continue; // órfão: o resultado legítimo é consumido junto da chamada
		const { providerItems, ...rest } = message;
		const kept: SerializedLlmMessage = providerItems && options.model && providerItems.model === options.model ? message : { ...rest };
		const calls = message.role === "assistant" ? (message.tool_calls ?? []) : [];
		out.push(kept);
		if (calls.length === 0) continue;
		const answers = new Map<string, SerializedLlmMessage>();
		let next = i + 1;
		while (next < messages.length && messages[next]!.role === "tool") {
			const result = messages[next]!;
			if (result.tool_call_id && !answers.has(result.tool_call_id)) answers.set(result.tool_call_id, result);
			next += 1;
		}
		for (const call of calls) {
			out.push(answers.get(call.id) ?? { role: "tool", tool_call_id: call.id, content: UNEXECUTED_CALL_RESULT });
		}
		i = next - 1;
	}
	return out.some((message) => message.role !== "system") ? out : null;
}

/**
 * Diverge por id, nunca por texto: a mensagem da marca d'água sumiu, ou há menos mensagens até ela do que
 * havia quando o run começou. Devolve o motivo (para o log) ou `null` se a conversa gravada ainda vale.
 */
export function watermarkDivergence(
	stored: { count: number } | undefined,
	now: { exists: boolean; countUpTo: number },
): "no_watermark" | "watermark_missing" | "history_shrunk" | null {
	if (!stored) return "no_watermark";
	if (!now.exists) return "watermark_missing";
	if (now.countUpTo < stored.count) return "history_shrunk";
	return null;
}

/**
 * Junta a conversa limpa do run anterior com o que a conversa ganhou depois da marca d'água (falas do usuário
 * e de outros autores; o que o próprio run gravou já está na conversa dele). `after` vem do banco, em ordem.
 * O pedido do turno atual sai do fim (entra à parte). Fala do usuário gravada durante o run que já foi
 * absorvida por ele (mensagem enviada com o run em andamento) não entra de novo.
 */
export function buildTranscriptHistory(input: {
	transcript: SerializedLlmMessage[];
	after: ReadonlyArray<{ role: string; content: string; createdAt?: string }>;
	/** Pedido do turno atual. */
	objective: string;
	/** Fim da janela do run anterior (ISO): falas do usuário até aí foram lidas por ele. */
	priorRunEndedAt?: string;
}): SerializedLlmMessage[] {
	let after = input.after.filter((message) => message.role === "user" || message.role === "assistant");
	const objective = input.objective.trim();
	const last = after[after.length - 1];
	if (objective && last?.role === "user" && last.content.trim() === objective) after = after.slice(0, -1);
	const absorbed = new Set(input.transcript.filter((message) => message.role === "user").map((message) => transcriptTextOf(message).trim()));
	const ended = input.priorRunEndedAt ? Date.parse(input.priorRunEndedAt) : Number.NaN;
	after = after.filter((message) => {
		if (message.role !== "user" || Number.isNaN(ended) || !message.createdAt) return true;
		return !(Date.parse(message.createdAt) <= ended && absorbed.has(message.content.trim()));
	});
	return [...input.transcript, ...after.map((message): SerializedLlmMessage => ({ role: message.role as "user" | "assistant", content: message.content }))];
}

/**
 * Coloca o resultado de uma aprovação já executada como resultado da última chamada a `toolName`
 * (a que ficou pendente no cartão). `null` = a chamada não está na conversa.
 */
export function attachPendingResult(transcript: SerializedLlmMessage[], toolName: string, content: string): SerializedLlmMessage[] | null {
	for (let i = transcript.length - 1; i >= 0; i -= 1) {
		const message = transcript[i]!;
		const call = message.role === "assistant" ? [...(message.tool_calls ?? [])].reverse().find((item) => item.function?.name === toolName) : undefined;
		if (!call) continue;
		const resultAt = transcript.findIndex((item, index) => index > i && item.role === "tool" && item.tool_call_id === call.id);
		if (resultAt < 0) return null;
		return transcript.map((item, index) => (index === resultAt ? { ...item, content } : item));
	}
	return null;
}

/** Nomes de tool chamados na conversa (as já usadas continuam carregadas no turno seguinte). */
export function calledToolNames(transcript: readonly SerializedLlmMessage[]): string[] {
	const names = new Set<string>();
	for (const message of transcript) {
		for (const call of message.tool_calls ?? []) {
			if (call.function?.name) names.add(call.function.name);
		}
	}
	return [...names];
}
