import { describe, expect, it } from "vitest";
import {
	isLiveStreamingBubble,
	shouldCancelCreatedRun,
} from "./chat-follow.js";
import { applyComputerUseEventsToTranscript } from "./run-transcript.js";

describe("shouldCancelCreatedRun", () => {
	it("não cancela quando a conversa visível já mudou", () => {
		expect(
			shouldCancelCreatedRun({
				createdForConversationId: "conv-a",
				visibleConversationId: "conv-b",
			}),
		).toBe(false);
	});

	it("cancela só se ainda estamos na conversa que pediu o run", () => {
		expect(
			shouldCancelCreatedRun({
				createdForConversationId: "conv-a",
				visibleConversationId: "conv-a",
			}),
		).toBe(true);
	});
});

describe("isLiveStreamingBubble", () => {
	it("cursor só no id que está recebendo texto", () => {
		expect(
			isLiveStreamingBubble({
				messageId: "cu-a",
				streamingMessageId: "cu-a",
				phase: "writing",
			}),
		).toBe(true);
		expect(
			isLiveStreamingBubble({
				messageId: "cu-b",
				streamingMessageId: "cu-a",
				phase: "writing",
			}),
		).toBe(false);
		expect(
			isLiveStreamingBubble({
				messageId: "cu-a",
				streamingMessageId: "cu-a",
				phase: "tool",
			}),
		).toBe(false);
		expect(
			isLiveStreamingBubble({
				messageId: "cu-old",
				streamingMessageId: null,
			}),
		).toBe(false);
	});
});

describe("replay sem JSON interno", () => {
	it("deltas públicos não incluem avaliação concluded", () => {
		const next = applyComputerUseEventsToTranscript([], [
			{ type: "assistant_delta", id: "step", delta: "Pronto." },
		]);
		expect(next[0]?.text).toBe("Pronto.");
		expect(next[0]?.text).not.toContain("concluded");
	});
});
