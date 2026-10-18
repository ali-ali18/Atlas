import type { ComputerUseEvent } from "./computer.js";

export type TranscriptBubble = {
	id: string;
	kind: "assistant" | "user" | "tool";
	text: string;
	label?: string;
	/** ISO; preservado entre transcript e thread. */
	createdAt?: string;
};

function upsertAssistant(
	messages: TranscriptBubble[],
	messageId: string,
	delta: string,
	replace = false,
): TranscriptBubble[] {
	const existing = messages.find((item) => item.id === messageId);
	if (existing && existing.kind === "assistant") {
		return messages.map((item) =>
			item.id === messageId && item.kind === "assistant"
				? { ...item, text: replace ? delta : `${item.text}${delta}` }
				: item,
		);
	}
	return [...messages, { id: messageId, kind: "assistant", text: delta }];
}

export function applyComputerUseEventToTranscript(
	messages: TranscriptBubble[],
	event: ComputerUseEvent,
): TranscriptBubble[] {
	switch (event.type) {
		case "assistant_delta":
			return upsertAssistant(messages, `cu-${event.id}`, event.delta);
		case "assistant_discard": {
			const lastAssistant = [...messages]
				.reverse()
				.find((item) => item.kind === "assistant" && item.id.startsWith("cu-"));
			if (!lastAssistant) return messages;
			return messages.map((item) =>
				item.id === lastAssistant.id && item.kind === "assistant"
					? { ...item, text: "" }
					: item,
			);
		}
		case "error": {
			const text = event.error.trim();
			if (!text) return messages;
			const lastAssistant = [...messages]
				.reverse()
				.find((item) => item.kind === "assistant");
			if (lastAssistant?.text.trim() === text) return messages;
			return upsertAssistant(messages, "cu-run-error", text, true);
		}
		default:
			return messages;
	}
}

export function applyComputerUseEventsToTranscript(
	messages: TranscriptBubble[],
	events: ComputerUseEvent[],
): TranscriptBubble[] {
	return events.reduce(applyComputerUseEventToTranscript, messages);
}
