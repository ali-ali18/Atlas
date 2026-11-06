// Um passo MODEL: chama o modelo e junta o stream. Só retries de TRANSPORTE (nunca de comportamento):
//  - `length` sem tool call → UMA continuação (o texto parcial vai junto, o modelo segue de onde parou);
//  - `error` → um retry igual; resposta vazia → um retry igual.
// Retry de erro depois de texto parcial já transmitido: o texto da tentativa abandonada é RETIRADO da tela
// (`onRetract`, vira `assistant_discard` no SSE) antes de a nova tentativa começar, senão o cliente mostraria
// o parcial duplicado (parcial + resposta inteira). Não há buffer: o streaming ao vivo continua. A continuação
// por `length` NÃO retira nada (o texto segue de onde parou).
// O texto do modelo passa byte a byte: nada é reescrito, trocado nem descartado. Resposta vazia depois
// do retry vira evento de status com o motivo real (quem chama emite).
// Sem corte por tempo aqui: o timeout de transporte é do adaptador da porta Llm e é generoso.
import type { Llm, LlmChatRequest, LlmMessage, LlmToolCall, LlmUsage } from "../ports/llm.js";
import { renderRuntimeBlock } from "../channels/envelope.js";
import type { RunNonce } from "../channels/nonce.js";

export type ModelReply = {
	text: string;
	calls: LlmToolCall[];
	finish: "stop" | "tool_calls" | "length" | "error";
	inputTokens: number;
	costUsd: number | undefined;
	/** Motivo real quando não houve resposta aproveitável. */
	problem?: "empty_reply" | "model_error" | "truncated";
};

type Once = { text: string; calls: LlmToolCall[]; finish: ModelReply["finish"]; usage?: LlmUsage };

async function once(llm: Llm, request: LlmChatRequest, onText: (text: string) => void | Promise<void>): Promise<Once> {
	let text = "";
	const calls: LlmToolCall[] = [];
	let finish: Once["finish"] = "error";
	let usage: LlmUsage | undefined;
	for await (const event of llm.chat(request)) {
		if (event.type === "text_delta") {
			text += event.text;
			await onText(event.text);
		} else if (event.type === "tool_call") calls.push(event.call);
		else if (event.type === "done") {
			finish = event.finishReason;
			usage = event.usage;
		}
	}
	return { text, calls, finish, ...(usage && { usage }) };
}

export const CONTINUATION_NOTE = "Your last message was cut off by the output length limit. Continue exactly where it stopped. Do not repeat what you already wrote.";

export async function callModel(input: {
	llm: Llm;
	messages: LlmMessage[];
	request: Omit<LlmChatRequest, "messages">;
	nonce: RunNonce;
	onText: (text: string) => void | Promise<void>;
	/** A tentativa anterior transmitiu texto e vai ser refeita: o cliente deve apagá-lo. */
	onRetract?: () => void | Promise<void>;
}): Promise<ModelReply> {
	const cost: Array<number | undefined> = [];
	let inputTokens = 0;
	const run = async (messages: LlmMessage[]) => {
		const result = await once(input.llm, { ...input.request, messages }, input.onText);
		cost.push(result.usage?.costUsd);
		if (result.usage) inputTokens = result.usage.inputTokens;
		return result;
	};
	const done = (r: Once, problem?: ModelReply["problem"]): ModelReply => {
		const known = cost.filter((c): c is number => c !== undefined);
		return { text: r.text, calls: r.calls, finish: r.finish, inputTokens, costUsd: known.length === cost.length ? known.reduce((a, b) => a + b, 0) : undefined, ...(problem && { problem }) };
	};

	let first = await run(input.messages);
	if (first.finish === "error") {
		if (first.text.length > 0) await input.onRetract?.();
		first = await run(input.messages);
		if (first.finish === "error") return done(first, "model_error");
	}
	if (first.finish === "length" && first.calls.length === 0 && first.text.length > 0) {
		const more = await run([...input.messages, { role: "assistant", content: first.text }, { role: "user", content: renderRuntimeBlock(input.nonce, CONTINUATION_NOTE) }]);
		const joined: Once = { text: first.text + more.text, calls: more.calls, finish: more.finish };
		return done(joined, more.finish === "length" ? "truncated" : more.finish === "error" ? "model_error" : undefined);
	}
	if (first.text.length === 0 && first.calls.length === 0) {
		const retry = await run(input.messages);
		return done(retry, retry.text.length === 0 && retry.calls.length === 0 ? "empty_reply" : undefined);
	}
	return done(first);
}
