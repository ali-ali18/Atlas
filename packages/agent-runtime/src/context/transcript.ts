import { createHash } from "node:crypto";
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
 * Deixa só o que vale levar para o turno seguinte: tira os system do começo (prompt, identidade e memória são
 * montados de novo a cada run), mantém as notas de sistema que vieram depois da primeira fala (foram enviadas ao
 * modelo nessa posição, e o prefixo do próximo pedido precisa repeti-las) e as de resumo/compactação, dá resposta a chamadas sem resultado e
 * descarta resultados órfãos. `providerItems` só ficam se o modelo for o mesmo. `null` = gravação corrompida.
 */
export function cleanTranscript(raw: unknown, options: { model?: string } = {}): SerializedLlmMessage[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	if (!raw.every(validShape)) return null;
	// Só o começo (prompt, identidade, memória) é refeito a cada run. As notas de sistema depois da primeira fala
	// foram enviadas ao modelo nessa posição e ficam como foram: o prefixo do próximo pedido repete o anterior.
	const firstTurn = (raw as SerializedLlmMessage[]).findIndex((message) => message.role !== "system");
	const messages = (raw as SerializedLlmMessage[]).filter((message, index) => message.role !== "system" || (firstTurn >= 0 && index > firstTurn) || isLayerNote(message));
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
		// Nota de sistema no meio da rodada espera o fim dela (os resultados ficam colados à chamada).
		const interleaved: SerializedLlmMessage[] = [];
		while (next < messages.length && (messages[next]!.role === "tool" || messages[next]!.role === "system")) {
			const result = messages[next]!;
			if (result.role === "system") interleaved.push(result);
			else if (result.tool_call_id && !answers.has(result.tool_call_id)) answers.set(result.tool_call_id, result);
			next += 1;
		}
		for (const call of calls) {
			out.push(answers.get(call.id) ?? { role: "tool", tool_call_id: call.id, content: UNEXECUTED_CALL_RESULT });
		}
		out.push(...interleaved);
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
 * Coloca o resultado de uma aprovação já executada como resultado da última chamada a `toolName` (a que ficou
 * pendente no cartão). Sem `toolName`, vale a última chamada que de fato rodou e parou no cartão: só se a conversa
 * termina nos resultados dessa rodada. `null` = a chamada não está na conversa.
 */
export function attachPendingResult(transcript: SerializedLlmMessage[], toolName: string | undefined, content: string): SerializedLlmMessage[] | null {
	if (!toolName) {
		let at = -1;
		for (let i = transcript.length - 1; i >= 0; i -= 1) {
			const message = transcript[i]!;
			if (message.role !== "tool") break;
			if (at < 0 && message.content !== UNEXECUTED_CALL_RESULT) at = i;
		}
		return at < 0 ? null : transcript.map((item, index) => (index === at ? { ...item, content } : item));
	}
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

const NAMESPACED_ID = /^r[0-9a-z]{6}_/;

/** Prefixo de um run nos ids de chamada de ferramenta (`r` + 6 últimos caracteres alfanuméricos do run). */
export function toolCallIdPrefix(runId: string): string {
	return `r${runId.replace(/[^0-9a-z]/gi, "").toLowerCase().slice(-6).padStart(6, "0")}_`;
}

/**
 * Id de chamada com o prefixo do run de origem. Idempotente: id já prefixado fica como está; o tamanho é
 * limitado (40) por hash estável. Pura: o mesmo (id, run) sempre dá o mesmo resultado.
 */
export function namespaceToolCallId(id: string, runId: string): string {
	if (NAMESPACED_ID.test(id)) return id;
	const prefix = toolCallIdPrefix(runId);
	const next = `${prefix}${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
	return next.length <= 40 ? next : `${prefix}${createHash("sha1").update(id).digest("hex").slice(0, 32)}`;
}

/**
 * Os itens opacos do provedor (Responses) trazem o `call_id` de cada chamada: acompanham a renomeação para
 * continuar casando com as chamadas da mensagem.
 */
export function renameProviderItemCallIds(
	providerItems: SerializedLlmMessage["providerItems"],
	rename: (id: string) => string,
): SerializedLlmMessage["providerItems"] {
	if (!providerItems) return providerItems;
	return {
		...providerItems,
		items: providerItems.items.map((item) =>
			item.type === "function_call" && typeof item.call_id === "string" ? { ...item, call_id: rename(item.call_id) } : item,
		),
	};
}

/**
 * Ids de chamada de ferramenta ganham o prefixo do run de origem, igual na chamada do assistente e no
 * resultado: um provedor que reaproveita `call_0` a cada run não embaralha os pares. Desde que o runtime
 * prefixa os ids ao criá-los (o que foi enviado ao modelo é o que fica gravado), isto só age em checkpoints
 * antigos; ids já prefixados ficam como estão.
 */
export function namespaceToolCallIds(messages: SerializedLlmMessage[], runId: string): SerializedLlmMessage[] {
	const rename = (id: string): string => namespaceToolCallId(id, runId);
	return messages.map((message) => {
		if (message.role === "tool" && message.tool_call_id) {
			const id = rename(message.tool_call_id);
			return id === message.tool_call_id ? message : { ...message, tool_call_id: id };
		}
		if (message.tool_calls?.length) {
			const calls = message.tool_calls.map((call) => ({ ...call, id: rename(call.id) }));
			if (calls.every((call, index) => call.id === message.tool_calls![index]!.id)) return message;
			return { ...message, tool_calls: calls, ...(message.providerItems ? { providerItems: renameProviderItemCallIds(message.providerItems, rename) } : {}) };
		}
		return message;
	});
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
