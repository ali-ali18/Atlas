import type { Message } from "@/components/ui/templates/template-4/data";

type NeedsUser = Extract<Message, { kind: "needs-user" }>;

/** Marcadores "X precisa de você" ainda pendentes (o remetente espera por eles). */
export function pendingNeedsUser(messages: readonly Message[]): NeedsUser[] {
	return messages.filter((message): message is NeedsUser => message.kind === "needs-user" && message.status === "pending");
}

/**
 * O remetente delegou e ainda espera o outro bot: o último sinal do fio é um
 * marcador de envio / "precisa de você" (não uma resposta que voltou).
 */
const AWAITING_MAX_AGE_MS = 6 * 60 * 60_000;

export function isAwaitingBot(messages: readonly Message[], now = Date.now()): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (message.kind === "bot-link" || message.kind === "needs-user") {
			// Marcador antigo sem resposta não vale polling eterno.
			const at = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
			return Number.isNaN(at) || now - at < AWAITING_MAX_AGE_MS;
		}
		if (message.kind === "user" && message.bot?.kind === "reply") return false;
	}
	return false;
}

/**
 * Traz para o fio os marcadores "precisa de você" que o servidor criou/atualizou
 * enquanto o remetente estava parado (sem mexer no resto da conversa).
 */
export function mergeNeedsUserMarkers(previous: Message[], refreshed: readonly Message[]): Message[] {
	let next = previous;
	for (const item of refreshed) {
		if (item.kind !== "needs-user" && item.kind !== "auto-decision") continue;
		const index = next.findIndex((message) => message.id === item.id);
		if (index >= 0) {
			const current = next[index]!;
			if (current.kind === item.kind && "status" in current && current.status === item.status) continue;
			next = next.map((message, position) => (position === index ? item : message));
			continue;
		}
		const at = item.createdAt ? next.findIndex((message) => message.createdAt !== undefined && message.createdAt > item.createdAt!) : -1;
		next = at >= 0 ? [...next.slice(0, at), item, ...next.slice(at)] : [...next, item];
	}
	return next;
}
