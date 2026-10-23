import type { ComputerUseEvent } from "./computer.js";
import { keepsRevisedDraft } from "./draft-revision.js";

export type TranscriptBubble = {
	id: string;
	kind: "assistant" | "user" | "tool";
	text: string;
	label?: string;
	/** ISO; preservado entre transcript e thread. */
	createdAt?: string;
	/**
	 * Fala transmitida que o run refez (`assistant_discard`): o texto continua, recolhido como rascunho
	 * revisado, com o motivo (`DraftRevisionReason`, ou "revised" em evento sem motivo).
	 */
	revised?: string;
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
			// Com id: o balão daquele passo. Sem id (evento antigo): o último balão ao vivo, como antes.
			const target = event.id
				? messages.find((item) => item.id === `cu-${event.id}` && item.kind === "assistant")
				: [...messages].reverse().find((item) => item.kind === "assistant" && item.id.startsWith("cu-"));
			if (!target || !target.text.trim() || target.revised) return messages;
			const revised = keepsRevisedDraft(event.reason) ? (event.reason ?? "revised") : null;
			return messages.map((item) =>
				item.id === target.id && item.kind === "assistant"
					? revised ? { ...item, revised } : { ...item, text: "" }
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
