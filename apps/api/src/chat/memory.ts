import type {
	ChatCompletionRequest,
	ChatMessage,
	MemoryReviewJobPayload,
} from "@workspace/shared";
import { ATLAS_JOB_NAMES, placeVolatileBeforeTurn, splitReplySegments } from "@workspace/shared";
import type { ChatCompletionQueue } from "@workspace/queue";
import {
	appendConversationMessage,
	buildMemoryAugmentedMessages,
	persistChatTurn,
	searchConversationMessages,
	type ConversationSearchHit,
} from "@workspace/db";

const SEARCH_SNIPPET_LIMIT = 300;
const SEARCH_HIT_LIMIT = 4;

function truncateSnippet(content: string, max = SEARCH_SNIPPET_LIMIT): string {
	const normalized = content.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function renderSearchSnippets(hits: ConversationSearchHit[]): string {
	const lines = hits.map(
		(hit) => `- (${hit.role}) ${truncateSnippet(hit.content)}`,
	);
	return [
		"════ TRECHOS DE CONVERSAS PASSADAS (busca) ════",
		...lines,
	].join("\n");
}

export function lastUserMessage(
	messages: ChatMessage[],
): ChatMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role === "user") {
			return message;
		}
	}
	return undefined;
}

type PrepareDeps = {
	buildMemoryAugmentedMessages: typeof buildMemoryAugmentedMessages;
	searchConversationMessages: typeof searchConversationMessages;
};

export async function prepareMessagesForCompletion(
	request: ChatCompletionRequest,
	userId?: string,
	deps: PrepareDeps = { buildMemoryAugmentedMessages, searchConversationMessages },
): Promise<ChatMessage[]> {
	try {
		const augmented = await deps.buildMemoryAugmentedMessages(request.messages, {
			userId,
			botId: request.botId,
			conversationId: request.conversationId,
		});

		// Sem dono não há busca: trechos de conversas passadas só do próprio usuário.
		const lastUser = lastUserMessage(request.messages);
		if (userId && lastUser && lastUser.content.trim().length > 0) {
			const hits = await deps.searchConversationMessages(lastUser.content, {
				limit: SEARCH_HIT_LIMIT,
				excludeConversationId: request.conversationId,
				userId,
				// Cada bot só vê a própria conversa: nunca trechos de outros bots.
				...(request.botId ? { botId: request.botId } : {}),
			});
			// F2: trechos dependem do pedido atual, então vão colados ao turno
			// (depois do histórico), nunca antes dele no prefixo cacheável.
			if (hits.length > 0) {
				return placeVolatileBeforeTurn(augmented, [renderSearchSnippets(hits)]);
			}
		}

		return augmented;
	} catch (error) {
		console.error("memory context load failed; using raw messages", error);
		return request.messages;
	}
}

export async function persistCompletionIfNeeded(
	request: ChatCompletionRequest,
	assistantContent: string,
): Promise<void> {
	if (!request.conversationId) {
		return;
	}

	const user = lastUserMessage(request.messages);
	try {
		await persistChatTurn(
			request.conversationId,
			user?.content ?? null,
			assistantContent,
		);
	} catch (error) {
		console.error("failed to persist chat turn", error);
	}
}

/**
 * Persiste o turno quebrando a resposta do assistente em parágrafos — cada um
 * vira uma mensagem. Assim, ao recarregar a conversa, ela continua fragmentada
 * (um balão por parágrafo) como apareceu ao vivo.
 */
export async function persistCompletionSegmented(
	request: ChatCompletionRequest,
	assistantContent: string,
): Promise<void> {
	if (!request.conversationId) {
		return;
	}

	const conversationId = request.conversationId;
	const user = lastUserMessage(request.messages);
	try {
		if (user?.content && user.content.trim().length > 0) {
			await appendConversationMessage(
				conversationId,
				"user",
				user.content.trim(),
			);
		}

		const segments = splitReplySegments(assistantContent);

		for (const segment of segments) {
			await appendConversationMessage(conversationId, "assistant", segment);
		}
	} catch (error) {
		console.error("failed to persist chat turn", error);
	}
}

export function buildMemoryReviewPayload(
	request: ChatCompletionRequest,
	assistantText: string,
	userId?: string,
): MemoryReviewJobPayload {
	return {
		userId: userId ?? "default",
		botId: request.botId,
		conversationId: request.conversationId,
		messages: [
			...request.messages,
			{ role: "assistant", content: assistantText },
		],
	};
}

export async function enqueueMemoryReview(
	queue: ChatCompletionQueue | null,
	payload: MemoryReviewJobPayload,
): Promise<void> {
	if (!queue) {
		return;
	}

	try {
		await queue.add(ATLAS_JOB_NAMES.memoryReview, payload);
	} catch (error) {
		console.error("failed to enqueue memory review", error);
	}
}
