import type {
	ChatCompletionRequest,
	ChatMessage,
	ChatRole,
} from "@workspace/shared";
import { API_INPUT_LIMITS, validMaxSteps } from "./input-limits.js";

const CHAT_ROLES: readonly ChatRole[] = [
	"system",
	"user",
	"assistant",
	"tool",
];

function isChatRole(value: unknown): value is ChatRole {
	return (
		typeof value === "string" &&
		(CHAT_ROLES as readonly string[]).includes(value)
	);
}

function parseChatMessages(value: unknown): ChatMessage[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > API_INPUT_LIMITS.messages) {
		return null;
	}

	const messages: ChatMessage[] = [];

	for (const item of value) {
		if (
			typeof item !== "object" ||
			item === null ||
			!("role" in item) ||
			!("content" in item)
		) {
			return null;
		}

		const { role, content } = item as { role: unknown; content: unknown };

		if (!isChatRole(role) || typeof content !== "string" || content.length > API_INPUT_LIMITS.contentChars) {
			return null;
		}

		if (content.trim().length === 0) {
			return null;
		}

		messages.push({ role, content });
	}

	return messages;
}

export function parseChatCompletionRequest(
	body: unknown,
): ChatCompletionRequest | null {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return null;
	}
	if (!validMaxSteps("maxSteps" in body ? body.maxSteps : undefined)) return null;

	const messages = parseChatMessages(
		"messages" in body ? body.messages : undefined,
	);
	if (!messages) {
		return null;
	}

	const model =
		"model" in body && typeof body.model === "string" && body.model.trim()
			? body.model.trim()
			: undefined;

	const conversationId =
		"conversationId" in body &&
		typeof body.conversationId === "string" &&
		body.conversationId.trim()
			? body.conversationId.trim()
			: undefined;

	const botId =
		"botId" in body && typeof body.botId === "string" && body.botId.trim()
			? body.botId.trim()
			: undefined;

	return { messages, model, conversationId, botId };
}
