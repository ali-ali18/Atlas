import type { LlmMessage } from "@workspace/llm";

export function lastUserPlainText(conversation: LlmMessage[]): string {
	return recentUserPlainTexts(conversation, 1)[0] ?? "";
}

/** Texto das falas do assistente nas últimas `window` mensagens (nunca resultados de tool). */
export function recentAssistantPlainTexts(conversation: LlmMessage[], window = 6): string[] {
	const out: string[] = [];
	for (const message of conversation.slice(-window)) {
		if (message.role !== "assistant") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n")
					: "";
		if (text.trim()) out.push(text);
	}
	return out;
}

export function recentUserPlainTexts(
	conversation: LlmMessage[],
	limit = 8,
): string[] {
	const out: string[] = [];
	for (let i = conversation.length - 1; i >= 0 && out.length < limit; i--) {
		const message = conversation[i]!;
		if (message.role !== "user") continue;
		const content = message.content;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.filter(
					(part): part is { type: "text"; text: string } =>
						part.type === "text",
				)
				.map((part) => part.text)
				.join("\n");
		}
		const trimmed = text.trim();
		if (trimmed) out.push(trimmed);
	}
	return out;
}
