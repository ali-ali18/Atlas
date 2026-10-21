import { applyCacheBreakpoints, configuredCacheTtl, type PromptCacheTtl } from "../prompt-cache.js";
import { demoteSystemNotes, remapStableIndex } from "../system-notes.js";
import type { ChatTool, CompleteChatWithToolsParams, LlmContentPart, LlmMessage } from "../chat-tools.js";

type Cache = { type: "ephemeral"; ttl?: "5m" | "1h" };
export type AnthropicBlock =
	| { type: "text"; text: string; cache_control?: Cache }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
	| { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: "tool_result"; tool_use_id: string; content: string | AnthropicBlock[]; is_error?: boolean };
export type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };
export type AnthropicTool = { name: string; description: string; input_schema: Record<string, unknown>; cache_control?: Cache };
export type AnthropicRequest = {
	model: string;
	max_tokens: number;
	system?: Array<{ type: "text"; text: string; cache_control?: Cache }>;
	messages: AnthropicMessage[];
	tools?: AnthropicTool[];
	tool_choice?: { type: "auto" | "any" | "none" };
	stream: true;
};

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_000;
const ephemeral = (ttl?: PromptCacheTtl): Cache => ({ type: "ephemeral", ...(ttl ? { ttl } : {}) });
const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

function imageBlock(url: string): AnthropicBlock | null {
	const data = DATA_URL.exec(url);
	if (data) return { type: "image", source: { type: "base64", media_type: data[1]!, data: data[2]! } };
	if (url.startsWith("https://")) return { type: "image", source: { type: "url", url } };
	return null;
}

function partToBlock(part: LlmContentPart): AnthropicBlock | null {
	if (part.type === "text") {
		if (!part.text) return null;
		return { type: "text", text: part.text, ...(part.cache_control ? { cache_control: part.cache_control } : {}) };
	}
	if (part.type === "image_url") return imageBlock(part.image_url.url);
	if (part.type === "file") {
		const data = DATA_URL.exec(part.file.file_data);
		return data && data[1] === "application/pdf" ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: data[2]! }, title: part.file.filename.slice(0, 120) } : null;
	}
	// Referências de artefato nunca vão ao provedor: o runtime as expande antes da chamada.
	return null;
}

function blocksOf(content: LlmMessage["content"]): AnthropicBlock[] {
	if (content === null || content === undefined) return [];
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	return content.map(partToBlock).filter((block): block is AnthropicBlock => block !== null);
}

function parseArguments(raw: string): unknown {
	try {
		const value: unknown = JSON.parse(raw || "{}");
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

/** `tool_result` precisa vir antes de qualquer outro bloco no turno de usuário. */
function pushUser(out: AnthropicMessage[], blocks: AnthropicBlock[]) {
	if (!blocks.length) return;
	const last = out[out.length - 1];
	if (last?.role === "user") {
		const all = [...last.content, ...blocks];
		last.content = [...all.filter((b) => b.type === "tool_result"), ...all.filter((b) => b.type !== "tool_result")];
	} else out.push({ role: "user", content: blocks });
}

export function toAnthropicTools(tools: ChatTool[], cache: boolean, ttl?: PromptCacheTtl): AnthropicTool[] {
	const out: AnthropicTool[] = tools.map((tool) => ({
		name: tool.function.name,
		description: tool.function.description,
		input_schema: tool.function.parameters,
	}));
	// Breakpoint no último tool: o bloco de ferramentas (estável) entra no cache.
	if (cache && out.length) out[out.length - 1] = { ...out[out.length - 1]!, cache_control: ephemeral(ttl) };
	return out;
}

export function toAnthropicMessages(messages: readonly LlmMessage[]): { system: AnthropicRequest["system"]; messages: AnthropicMessage[] } {
	const system: NonNullable<AnthropicRequest["system"]> = [];
	const out: AnthropicMessage[] = [];
	for (const message of messages) {
		if (message.role === "system") {
			for (const block of blocksOf(message.content))
				if (block.type === "text") system.push({ type: "text", text: block.text, ...(block.cache_control ? { cache_control: block.cache_control } : {}) });
			continue;
		}
		if (message.role === "tool") {
			const inner = blocksOf(message.content);
			const content: string | AnthropicBlock[] = inner.every((b) => b.type === "text")
				? inner.map((b) => (b.type === "text" ? b.text : "")).join("\n")
				: inner;
			pushUser(out, [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: content.length ? content : "(sem saída)" }]);
			continue;
		}
		if (message.role === "user") {
			pushUser(out, blocksOf(message.content));
			continue;
		}
		const blocks = blocksOf(message.content);
		for (const call of message.tool_calls ?? [])
			blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
		if (!blocks.length) continue;
		const last = out[out.length - 1];
		if (last?.role === "assistant") last.content.push(...blocks);
		else out.push({ role: "assistant", content: blocks });
	}
	return { system: system.length ? system : undefined, messages: out };
}

/**
 * Corpo da Messages API. Cache de prompt: até 4 breakpoints no total —
 * 1 no último tool e 3 reutilizando a política do OpenRouter (sistema, último
 * turno, fim do passo anterior); `cacheStableIndex` entra quando houver folga.
 */
export function anthropicRequestBody(params: CompleteChatWithToolsParams, slug: string, options: { cache?: boolean; ttl?: PromptCacheTtl | false } = {}): AnthropicRequest {
	const cache = options.cache !== false;
	const ttl = (options.ttl === undefined ? configuredCacheTtl() : options.ttl) || undefined;
	const hasTools = params.tools.length > 0;
	// Notas de sistema fora do começo viram texto na própria posição: um `system` novo mudaria o prefixo inteiro.
	const demoted = demoteSystemNotes(params.messages);
	const marked = cache ? applyCacheBreakpoints(demoted.messages, hasTools ? 3 : 4, { stableIndex: remapStableIndex(params.cacheStableIndex, demoted.positions), ttl }) : demoted.messages;
	const { system, messages } = toAnthropicMessages(marked);
	if (!messages.length) messages.push({ role: "user", content: [{ type: "text", text: "." }] });
	const choice = params.toolChoice ?? "auto";
	return {
		model: slug,
		max_tokens: params.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
		...(system ? { system } : {}),
		messages,
		...(hasTools ? { tools: toAnthropicTools(params.tools, cache, ttl), tool_choice: { type: choice === "required" ? "any" : choice } } : {}),
		stream: true,
	};
}
