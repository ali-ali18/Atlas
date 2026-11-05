import type { ChatTool, LlmContentPart, LlmMessage as LegacyMessage } from "@workspace/llm";
import type { LlmMessage, LlmToolSpec, LlmUserPart } from "../../ports/llm.js";

// Conversão da porta `Llm` para o formato do packages/llm (OpenAI/OpenRouter).

function imageUrl(part: Extract<LlmUserPart, { type: "image" }>): string {
	if (part.url) return part.url;
	if (part.data) return `data:${part.mediaType};base64,${part.data}`;
	throw new Error("Parte de imagem sem `data` nem `url`.");
}

function userContent(content: string | LlmUserPart[]): string | LlmContentPart[] {
	if (typeof content === "string") return content;
	return content.map((part): LlmContentPart => (part.type === "text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: imageUrl(part) } }));
}

/** Funde os `system` do começo, em ordem, num só (provedor que aceita um único system). */
export function mergeLeadingSystem(messages: readonly LlmMessage[]): LlmMessage[] {
	let end = 0;
	while (messages[end]?.role === "system") end += 1;
	if (end <= 1) return [...messages];
	const text = messages
		.slice(0, end)
		.map((m) => m.content as string)
		.join("\n\n");
	return [{ role: "system", content: text }, ...messages.slice(end)];
}

export function toLegacyMessages(messages: readonly LlmMessage[], opts: { mergeSystem: boolean }): LegacyMessage[] {
	const source = opts.mergeSystem ? mergeLeadingSystem(messages) : messages;
	return source.map((m): LegacyMessage => {
		switch (m.role) {
			case "system":
				return { role: "system", content: m.content };
			case "user":
				return { role: "user", content: userContent(m.content) };
			case "assistant":
				return {
					role: "assistant",
					content: m.content.length > 0 ? m.content : null,
					...(m.toolCalls?.length
						? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) }
						: {}),
				};
			default:
				return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
		}
	});
}

export function toLegacyTools(tools: readonly LlmToolSpec[] | undefined): ChatTool[] {
	return (tools ?? []).map((t) => {
		const schema = t.inputSchema;
		const properties = schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, unknown>) : {};
		const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : undefined;
		return { type: "function", function: { name: t.name, description: t.description, parameters: { type: "object", properties, ...(required ? { required } : {}) } } };
	});
}

/** Argumentos de tool vêm como JSON em texto; se não parsear, segue o texto cru para o executor recusar com a mensagem real. */
export function parseToolArgs(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
