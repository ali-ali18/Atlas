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

/**
 * Funde `user` seguidos numa só mensagem (provedor que exige papéis alternados). Ex.: fala do dono +
 * nota `<atlas:runtime>` + dado sem `toolCallId`. Texto vira texto com linha em branco entre as partes;
 * se alguma tem imagem, o resultado é uma lista de partes (texto e imagem na ordem). Não funde nada
 * além de `user` com `user`: `tool` e `assistant` separam os blocos. Função pura; o kernel guarda as
 * mensagens SEPARADAS (o checkpoint e as posições de `ownerIdx` dependem disso): a fusão é só da requisição.
 */
export function mergeConsecutiveUser(messages: readonly LlmMessage[]): LlmMessage[] {
	const out: LlmMessage[] = [];
	for (const m of messages) {
		const prev = out.at(-1);
		if (m.role !== "user" || prev?.role !== "user") {
			out.push(m);
			continue;
		}
		if (typeof prev.content === "string" && typeof m.content === "string") {
			out[out.length - 1] = { role: "user", content: `${prev.content}\n\n${m.content}` };
			continue;
		}
		const parts = (c: string | LlmUserPart[]): LlmUserPart[] => (typeof c === "string" ? [{ type: "text", text: c }] : c);
		out[out.length - 1] = { role: "user", content: [...parts(prev.content), ...parts(m.content)] };
	}
	return out;
}

export function toLegacyMessages(messages: readonly LlmMessage[], opts: { mergeSystem: boolean; mergeUser?: boolean }): LegacyMessage[] {
	const merged = opts.mergeSystem ? mergeLeadingSystem(messages) : messages;
	const source = opts.mergeUser ? mergeConsecutiveUser(merged) : merged;
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

/**
 * Converte as tools para o formato do legado. O schema vai INTEIRO (`anyOf`/`oneOf`/`additionalProperties`/`enum`
 * aninhados chegam ao provedor): descartar essas chaves em silêncio deixaria o modelo chamar a tool com argumentos
 * que o executor recusa. Schema que não é de objeto não é aceito pelos provedores de tools: falha alto.
 */
export function toLegacyTools(tools: readonly LlmToolSpec[] | undefined): ChatTool[] {
	return (tools ?? []).map((t) => {
		const schema = t.inputSchema;
		if (schema.type !== undefined && schema.type !== "object") throw new Error(`Schema da tool "${t.name}" precisa ser do tipo object (veio ${JSON.stringify(schema.type)}).`);
		const properties = schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, unknown>) : {};
		const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : undefined;
		const parameters: ChatTool["function"]["parameters"] & Record<string, unknown> = { ...schema, type: "object", properties, ...(required ? { required } : {}) };
		return { type: "function", function: { name: t.name, description: t.description, parameters } };
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
