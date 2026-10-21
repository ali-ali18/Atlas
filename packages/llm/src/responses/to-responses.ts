import type { LlmMessage } from "../chat-tools.js";
import { demoteSystemNotes } from "../system-notes.js";
export type ResponseItem = Record<string, unknown>;

/** Tradução pura; referências a artefatos precisam ser resolvidas pelo caller. */
export function toResponses(source: readonly LlmMessage[], model: string) {
	// `instructions` vem antes de tudo no prefixo: só o `system` do começo entra ali; as notas seguintes ficam na posição.
	const messages = demoteSystemNotes(source).messages;
	const instructions: string[] = [];
	const input: ResponseItem[] = [];
	const pending = new Set<string>();
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role === "system") {
			if (typeof message.content !== "string") throw new Error("System instructions must be text");
			instructions.push(message.content);
			continue;
		}
		if (message.role === "tool") {
			const id = message.tool_call_id;
			if (!id || !pending.delete(id)) throw new Error("Orphan function_call_output");
			if (typeof message.content !== "string") throw new Error("Tool output must be text");
			input.push({ type: "function_call_output", call_id: id, output: message.content });
			continue;
		}
		if (pending.size) throw new Error("Missing function_call_output before next message");
		for (const call of message.tool_calls ?? []) {
			if (!call.id || seen.has(call.id)) throw new Error("Duplicate or missing function call ID");
			seen.add(call.id);
			pending.add(call.id);
		}
		const opaque = message.providerItems;
		if (message.role === "assistant" && opaque?.provider === "chatgpt" && opaque.model === model) {
			const callIds = opaque.items.filter((item) => item.type === "function_call").map((item) => item.call_id);
			if (callIds.length !== pending.size || callIds.some((id) => typeof id !== "string" || !pending.has(id)) || new Set(callIds).size !== callIds.length)
				throw new Error("Provider items do not match assistant function calls");
			if (opaque.items.some((item) => !["reasoning", "function_call", "message"].includes(String(item.type))))
				throw new Error("Unsupported provider history item");
			// A mensagem textual, quando presente, já está no output original.
			if (!opaque.items.some((item) => item.type === "message") && message.content)
				input.push(assistantText(message));
			input.push(...opaque.items);
			continue;
		}
		if (message.role === "assistant") {
			if (message.content) input.push(assistantText(message));
			for (const call of message.tool_calls ?? [])
				input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" });
		} else {
			const content = typeof message.content === "string"
				? [{ type: "input_text", text: message.content }]
				: (message.content ?? []).map((part) => {
					if (part.type === "text") return { type: "input_text", text: part.text };
					if (part.type === "image_url") return { type: "input_image", image_url: part.image_url.url };
					if (part.type === "file") return { type: "input_file", filename: part.file.filename, file_data: part.file.file_data };
					throw new Error("Unresolved image reference in model input");
				});
			input.push({ role: "user", content });
		}
	}
	if (pending.size) throw new Error("Missing function_call_output at end of history");
	return { instructions: instructions.join("\n\n"), input };
}

function assistantText(message: LlmMessage): ResponseItem {
	if (typeof message.content !== "string") throw new Error("Assistant content must be text");
	return { role: "assistant", content: [{ type: "output_text", text: message.content }] };
}
