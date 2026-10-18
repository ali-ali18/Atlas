import type { LlmContentPart, LlmMessage } from "@workspace/llm";

/**
 * Escritor único de mensagens `user` no histórico do run (PLANO-RUN-V2 F1).
 * Duas regras de alternância que o provedor exige e que o merge de entradas
 * mid-run não pode quebrar:
 * 1. `user` nunca entra entre um `assistant(tool_calls)` e seus `tool` results;
 * 2. duas `user` seguidas viram uma só (burst collapse).
 */

export const USER_BURST_SEPARATOR = "\n\n";

export type AppendUserResult = "appended" | "merged" | "deferred";

/** Ids de tool_call do último `assistant(tool_calls)` que ainda não têm resultado. */
export function openToolCallIds(messages: readonly LlmMessage[]): string[] {
	const answered = new Set<string>();
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]!;
		if (message.role === "tool" && message.tool_call_id) {
			answered.add(message.tool_call_id);
			continue;
		}
		if (message.role === "assistant") {
			return (message.tool_calls ?? []).map((call) => call.id).filter((id) => !answered.has(id));
		}
		if (message.role === "user") return [];
	}
	return [];
}

/** Lote de tools em andamento: inserir `user` agora quebraria o par call/result. */
export function hasOpenToolBatch(messages: readonly LlmMessage[]): boolean {
	return openToolCallIds(messages).length > 0;
}

function toParts(content: LlmMessage["content"]): LlmContentPart[] {
	if (content === null) return [];
	return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

/** Junta dois conteúdos `user` preservando imagens (`image_ref` etc.) e a ordem. */
export function mergeUserContent(
	previous: LlmMessage["content"],
	next: string | LlmContentPart[],
): string | LlmContentPart[] {
	if (typeof previous === "string" && typeof next === "string") {
		return previous.length > 0 ? `${previous}${USER_BURST_SEPARATOR}${next}` : next;
	}
	const head = toParts(previous);
	const tail = toParts(next);
	const last = head[head.length - 1];
	const first = tail[0];
	if (last?.type === "text" && first?.type === "text") {
		tail[0] = { ...first, text: `${USER_BURST_SEPARATOR}${first.text}` };
	}
	return [...head, ...tail];
}

/**
 * Anexa uma mensagem do usuário. `deferred` = há lote de tools aberto: nada é
 * escrito e o chamador mantém a entrada pendente para a próxima fronteira.
 */
export function appendUserJoin(
	messages: LlmMessage[],
	content: string | LlmContentPart[],
): AppendUserResult {
	if (hasOpenToolBatch(messages)) return "deferred";
	const last = messages[messages.length - 1];
	if (last?.role === "user") {
		last.content = mergeUserContent(last.content, content);
		return "merged";
	}
	messages.push({ role: "user", content });
	return "appended";
}

/**
 * Anexa a resposta imediata a uma nota (`assistant`) logo após a nota `user` e
 * uma continuação `user` curta: sem ela o próximo passo terminaria em
 * `assistant` (prefill), que vários provedores rejeitam. Só vale com a última
 * mensagem sendo `user` e sem lote de tools aberto; senão não escreve nada.
 */
export const ACK_CONTINUE_PROMPT = "(Continue the original task.)";

export function appendAssistantAck(messages: LlmMessage[], text: string): boolean {
	if (hasOpenToolBatch(messages)) return false;
	if (messages[messages.length - 1]?.role !== "user") return false;
	messages.push({ role: "assistant", content: text });
	messages.push({ role: "user", content: ACK_CONTINUE_PROMPT });
	return true;
}
