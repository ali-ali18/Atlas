// Menu ao segurar uma mensagem: o que ele oferece por mensagem e como a reação do usuário muda. Só lógica pura
// (sem React nem rede); quem chama o servidor é o `ChatController`.
import type { ChatItem, Reaction } from "./chat-types";

/** Reações do menu, em duas fileiras. Todas passam em `normalizeReactionEmoji` (o servidor aceita qualquer pictograma). */
export const REACTION_ROWS: readonly (readonly string[])[] = [
	["👍", "👎", "❤️", "😂", "🎉", "😮"],
	["🔥", "👀", "🙏", "😢", "💯"],
];

type Spoken = Extract<ChatItem, { kind: "user" | "assistant" }>;

/** Só a fala que o servidor já gravou tem id dele: o balão otimista (`msg-*`) e a fala ao vivo (`cu-*`) ainda não. */
export function isStoredMessage(item: ChatItem): item is Spoken {
	if (item.kind !== "user" && item.kind !== "assistant") return false;
	return !item.id.startsWith("msg-") && !item.id.startsWith("cu-") && item.text.trim().length > 0;
}

/** A reação do usuário nesta mensagem (a do bot não conta), ou `null`. */
export function myReaction(reactions: readonly Reaction[] | undefined): string | null {
	return reactions?.find((item) => item.actor === "user")?.emoji ?? null;
}

/**
 * Reações depois de o usuário tocar em `emoji`: sem reação, adiciona; outra, troca; a mesma, remove. A do bot fica
 * como está. Sem nenhuma reação sobrando devolve `undefined` (o item não leva o campo).
 */
/** Mesmas reações (ator + emoji, na mesma ordem)? `undefined` e lista vazia contam como iguais. */
export function sameReactions(a: readonly Reaction[] | undefined, b: readonly Reaction[] | undefined): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return left.length === right.length && left.every((item, index) => item.actor === right[index]?.actor && item.emoji === right[index]?.emoji);
}

export function toggleUserReaction(reactions: readonly Reaction[] | undefined, emoji: string): Reaction[] | undefined {
	const others = (reactions ?? []).filter((item) => item.actor !== "user");
	const next = myReaction(reactions) === emoji ? others : [...others, { actor: "user" as const, emoji }];
	return next.length ? next : undefined;
}

export type MessageMenu = {
	/** Texto para copiar e para a tela de seleção. */
	text: string;
	/** Id do run que gravou a fala do bot (`null`: o usuário, ou fala sem run). */
	runId: string | null;
	reaction: string | null;
};

/** O que o menu mostra para esta linha; `null` = não abre (cartão, marcador, balão ainda não gravado). */
export function messageMenuFor(item: ChatItem): MessageMenu | null {
	if (!isStoredMessage(item)) return null;
	return {
		text: item.text,
		runId: item.kind === "assistant" && item.runId ? item.runId : null,
		reaction: myReaction(item.reactions),
	};
}
