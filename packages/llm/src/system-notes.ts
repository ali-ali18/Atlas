import type { LlmContentPart, LlmMessage } from "./chat-tools.js";

/**
 * Notas de sistema no meio da conversa (avisos do turno, lembretes de tarefa, procedimentos) não podem ficar
 * com o papel `system`: Anthropic e Responses juntam TODO `system` no cabeçalho do pedido, e uma nota nova
 * ali muda o prefixo inteiro (o cache de prompt só reaproveita o que é idêntico desde o início). Aqui só o
 * bloco de `system` do começo continua como está; as notas seguintes viram trecho de texto delimitado na
 * posição em que estão, como o lembrete de sistema do Claude Code. Notas no meio de uma rodada de ferramenta
 * (entre a chamada e o último resultado) esperam o fim da rodada: a API exige os resultados logo depois da chamada.
 */
export const SYSTEM_NOTE_OPEN = "<system-reminder>";
export const SYSTEM_NOTE_CLOSE = "</system-reminder>";

function noteText(message: LlmMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

export function wrapSystemNote(text: string): string {
	return `${SYSTEM_NOTE_OPEN}\n${text}\n${SYSTEM_NOTE_CLOSE}`;
}

export type DemotedSystemNotes = {
	messages: LlmMessage[];
	/** Posição na lista de saída de cada mensagem da entrada (uma nota que espera o fim da rodada muda de lugar). */
	positions: number[];
};

export function demoteSystemNotes(messages: readonly LlmMessage[]): DemotedSystemNotes {
	const out: LlmMessage[] = [];
	const positions: number[] = new Array(messages.length).fill(-1);
	const held: Array<{ index: number; message: LlmMessage }> = [];
	const open = new Set<string>();
	let leading = true;
	// Nota nunca vira turno de usuário só com contexto: o modelo responderia a ela ("Entendi, agora são 17h37").
	// Cola como bloco delimitado no fim da última fala real do usuário (o mesmo turno); só fica solta logo
	// depois de um resultado de ferramenta (rodada em andamento) ou quando ainda não há fala do usuário.
	const place = (index: number, note: LlmMessage) => {
		const part = (note.content as LlmContentPart[])[0]!;
		let target = out.length - 1;
		if (out[target]?.role === "assistant") {
			while (target >= 0 && out[target]?.role !== "user") target -= 1;
		}
		const host = target >= 0 && out[target]?.role === "user" ? out[target]! : null;
		if (!host) {
			positions[index] = out.length;
			out.push(note);
			return;
		}
		const current: LlmContentPart[] = typeof host.content === "string" ? (host.content ? [{ type: "text", text: host.content }] : []) : (host.content ?? []);
		out[target] = { ...host, content: [...current, part] };
		positions[index] = target;
	};
	const flush = () => {
		for (const item of held.splice(0)) place(item.index, item.message);
	};
	messages.forEach((message, index) => {
		if (message.role === "system") {
			if (leading) {
				positions[index] = out.length;
				out.push(message);
				return;
			}
			const text = noteText(message);
			if (!text.trim()) {
				positions[index] = out.length;
				return;
			}
			const part: LlmContentPart = { type: "text", text: wrapSystemNote(text) };
			const note: LlmMessage = { role: "user", content: [part] };
			if (open.size > 0) held.push({ index, message: note });
			else place(index, note);
			return;
		}
		leading = false;
		positions[index] = out.length;
		out.push(message);
		if (message.role === "assistant") {
			for (const call of message.tool_calls ?? []) open.add(call.id);
		} else if (message.role === "tool" && message.tool_call_id) {
			open.delete(message.tool_call_id);
			if (open.size === 0) flush();
		}
	});
	flush();
	return { messages: out, positions };
}

/** Índice do runtime (`cacheStableIndex`) na lista depois de `demoteSystemNotes`; indefinido se a mensagem sumiu. */
export function remapStableIndex(index: number | undefined, positions: readonly number[]): number | undefined {
	if (index === undefined || !Number.isInteger(index) || index < 0 || index >= positions.length) return undefined;
	const at = positions[index]!;
	return at >= 0 ? at : undefined;
}

/**
 * Ordem fixa das chaves de cada mensagem (e das chamadas de ferramenta): a mesma mensagem tem os mesmos bytes
 * quando vem direto do provedor e quando volta do checkpoint, que grava as chaves em outra ordem.
 */
export function canonicalMessage(message: LlmMessage): LlmMessage {
	const out: LlmMessage = { role: message.role, content: message.content };
	if (message.tool_calls) {
		out.tool_calls = message.tool_calls.map((call) => ({
			id: call.id,
			type: "function",
			function: { name: call.function.name, arguments: call.function.arguments },
		}));
	}
	if (message.tool_call_id !== undefined) out.tool_call_id = message.tool_call_id;
	if (message.providerItems) out.providerItems = message.providerItems;
	return out;
}
