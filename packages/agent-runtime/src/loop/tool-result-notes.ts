import type { LlmMessage } from "@workspace/llm";

/**
 * Notas do runtime no meio do run (estilo Hermes): nada de mensagem `system` nova no meio da tarefa, que o modelo
 * fraco lê como regra nova. Avisos de laço, orçamento e estagnação, procedimentos que só valem depois de uma tool
 * (consulta de dados, guia de conector, lições do conector) vão ANEXADOS ao resultado de tool mais recente.
 * Mensagens do usuário durante a tarefa NÃO passam por aqui: continuam chegando como `user` (ver `loop/inputs.ts`).
 */

/** Separador de cada nota anexada; a higiene preserva o que vem depois dele ao encurtar um resultado grande. */
export const TOOL_RESULT_NOTE_MARKER = "\n\n[Runtime note] ";

/** Índice do resultado de tool do lote atual (depois da última fala do assistente); -1 se o lote já fechou. */
function latestToolResultIndex(conversation: readonly LlmMessage[]): number {
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		const role = conversation[index]!.role;
		if (role === "tool") return index;
		if (role === "assistant") return -1;
	}
	return -1;
}

export function hasLatestToolResult(conversation: readonly LlmMessage[]): boolean {
	return latestToolResultIndex(conversation) >= 0;
}

/** Anexa `text` ao resultado de tool mais recente (in place). `false` = não há resultado no lote atual. */
export function appendToLatestToolResult(conversation: LlmMessage[], text: string): boolean {
	const index = latestToolResultIndex(conversation);
	if (index < 0 || !text.trim()) return false;
	const message = conversation[index]!;
	const note = `${TOOL_RESULT_NOTE_MARKER}${text.trim()}`;
	if (Array.isArray(message.content)) {
		conversation[index] = { ...message, content: [...message.content, { type: "text", text: note.trimStart() }] };
	} else {
		conversation[index] = { ...message, content: `${message.content ?? ""}${note}` };
	}
	return true;
}

/** Corpo e notas anexadas de um resultado de tool (a higiene encurta só o corpo). */
export function splitToolResultNotes(content: string): { body: string; notes: string } {
	const at = content.indexOf(TOOL_RESULT_NOTE_MARKER);
	return at < 0 ? { body: content, notes: "" } : { body: content.slice(0, at), notes: content.slice(at) };
}

function textOf(message: LlmMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** A nota já foi dada neste run (em mensagem de sistema antiga ou anexada a um resultado)? Vale numa retomada. */
export function conversationHasNote(conversation: readonly LlmMessage[], note: string): boolean {
	return conversation.some((message) => (message.role === "system" || message.role === "tool") && textOf(message).includes(note));
}

/**
 * Fila de avisos do passo: no máximo UM vai ao modelo por passo (o de maior prioridade; empate, o primeiro), anexado
 * ao resultado de tool mais recente. Os outros esperam o passo seguinte; repetido na fila não entra, e o marcado
 * `once` não volta depois de dado.
 */
export function createStepNotices() {
	const queue: Array<{ text: string; priority: number; order: number; once: boolean }> = [];
	let order = 0;
	return {
		/** `once`: aviso que vale uma vez no run (já dado = não volta, inclusive numa retomada). */
		push(text: string | null | undefined, priority = 1, options: { once?: boolean } = {}): void {
			const clean = text?.trim();
			if (!clean || queue.some((item) => item.text === clean)) return;
			queue.push({ text: clean, priority, order: order++, once: options.once === true });
		},
		/** Anexa o aviso mais importante; devolve o texto anexado (ou `null`). */
		flush(conversation: LlmMessage[]): string | null {
			while (queue.length > 0) {
				queue.sort((a, b) => b.priority - a.priority || a.order - b.order);
				const next = queue[0]!;
				if (next.once && conversationHasNote(conversation, next.text)) {
					queue.shift();
					continue;
				}
				if (!appendToLatestToolResult(conversation, next.text)) return null;
				queue.shift();
				return next.text;
			}
			return null;
		},
		pending(): number {
			return queue.length;
		},
	};
}

/** Prioridade dos avisos: fechar no orçamento passa na frente; o resto vai na ordem em que surgiu. */
export const NOTICE_PRIORITY = { budget: 2, normal: 1 } as const;

/** Notas anexadas aos resultados de tool da conversa, na ordem (cada uma sem o marcador). */
export function appendedToolNotes(conversation: readonly LlmMessage[]): string[] {
	const out: string[] = [];
	for (const message of conversation) {
		if (message.role !== "tool") continue;
		const text = textOf(message).replace(/^\[Runtime note\] /m, TOOL_RESULT_NOTE_MARKER);
		const parts = text.split(TOOL_RESULT_NOTE_MARKER);
		out.push(...parts.slice(1));
	}
	return out;
}
