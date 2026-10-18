export function shouldCancelCreatedRun(input: {
	createdForConversationId: string;
	visibleConversationId: string | null;
}): boolean {
	return input.visibleConversationId === input.createdForConversationId;
}

export function isLiveStreamingBubble(input: {
	messageId: string;
	streamingMessageId: string | null;
	phase?: string;
}): boolean {
	if (!input.streamingMessageId) return false;
	if (input.phase === "tool" || input.phase === "idle") return false;
	return input.messageId === input.streamingMessageId;
}
