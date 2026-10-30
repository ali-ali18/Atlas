import { useSyncExternalStore } from "react";
import type { MessageReaction } from "@workspace/shared";
import { toast } from "@workspace/ui/lib/toast-store";
import { clearMessageReaction, getMessageReactions, setMessageReaction } from "@/lib/atlas-api";
import { activeT } from "@/lib/i18n/active";

/**
 * Reações das falas no cliente. A verdade é o servidor: a lista da conversa semeia o estado (`seed`),
 * o hub avisa de mudanças feitas em outra aba/aparelho (`refresh`) e o clique é otimista (`toggle`):
 * aparece na hora, o PUT/DELETE confirma, e se falhar volta ao último estado confirmado com um aviso.
 * Um clique por mensagem de cada vez; cliques durante o envio viram um último desejo aplicado depois.
 */

const EMPTY: readonly MessageReaction[] = Object.freeze([]);
export const reactionFailureMessage = () => activeT("errors.reactionFailed");

/** Id de mensagem já gravada no servidor. As locais (otimistas `msg-…`, ao vivo `cu-…`, demos `live-…`) ainda não reagem. */
export function isPersistedMessageId(id: string): boolean {
	return id.length > 0 && !/^(?:msg|cu|live|local)-/.test(id);
}

export function userEmoji(reactions: readonly MessageReaction[] | undefined): string | null {
	return reactions?.find((reaction) => reaction.actor === "user")?.emoji ?? null;
}

export function withUserEmoji(reactions: readonly MessageReaction[] | undefined, emoji: string | null): MessageReaction[] {
	const others = (reactions ?? []).filter((reaction) => reaction.actor !== "user");
	return emoji ? [...others, { actor: "user", emoji }] : others;
}

type Entry = {
	shown: readonly MessageReaction[];
	confirmed: readonly MessageReaction[];
	pending: boolean;
	/** Último desejo do usuário enquanto uma chamada está em andamento (`undefined` = nenhum). */
	wish?: string | null;
};

export type ReactionApi = {
	set: (messageId: string, emoji: string) => Promise<MessageReaction[]>;
	clear: (messageId: string) => Promise<MessageReaction[]>;
	get: (messageId: string) => Promise<MessageReaction[]>;
};

const same = (a: readonly MessageReaction[], b: readonly MessageReaction[]) =>
	a.length === b.length && a.every((item, index) => item.actor === b[index]?.actor && item.emoji === b[index]?.emoji);

export function createReactionStore(api: ReactionApi, notify: (message: string) => void) {
	const entries = new Map<string, Entry>();
	const listeners = new Set<() => void>();
	const emit = () => {
		for (const listener of listeners) listener();
	};
	const put = (id: string, entry: Entry) => {
		const previous = entries.get(id);
		entries.set(id, entry);
		if (!previous || previous.shown !== entry.shown) emit();
	};

	/** Aplica o que o servidor diz, a menos que haja uma chamada nossa em andamento (ela traz o estado novo). */
	function applyServer(id: string, reactions: readonly MessageReaction[]) {
		const current = entries.get(id);
		if (current?.pending) return;
		if (!current && reactions.length === 0) return;
		const next = current && same(current.shown, reactions) ? current.shown : reactions;
		put(id, { shown: next, confirmed: next, pending: false });
	}

	async function run(id: string, emoji: string | null) {
		const entry = entries.get(id)!;
		try {
			const server = emoji ? await api.set(id, emoji) : await api.clear(id);
			const wish = entries.get(id)?.wish;
			put(id, { shown: server, confirmed: server, pending: false });
			if (wish !== undefined && wish !== userEmoji(server)) {
				put(id, { shown: withUserEmoji(server, wish), confirmed: server, pending: true });
				await run(id, wish);
			}
		} catch {
			// Volta ao último estado confirmado (descartando também o desejo que ficou na fila).
			put(id, { shown: entry.confirmed, confirmed: entry.confirmed, pending: false });
			notify(reactionFailureMessage());
		}
	}

	return {
		get: (id: string): readonly MessageReaction[] | undefined => entries.get(id)?.shown,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Estado vindo da lista da conversa. `undefined` = a mensagem não tem reações no servidor. */
		seed(id: string, reactions: readonly MessageReaction[] | undefined) {
			applyServer(id, reactions ?? EMPTY);
		},
		/** Aviso do hub: busca as reações atuais da mensagem. */
		async refresh(id: string) {
			if (entries.get(id)?.pending) return;
			try {
				applyServer(id, await api.get(id));
			} catch {
				// próximo aviso ou recarga corrige
			}
		},
		/** Reagir com `emoji`; repetir o mesmo emoji tira a reação. */
		toggle(id: string, emoji: string): Promise<void> {
			const current = entries.get(id);
			const target = userEmoji(current?.shown) === emoji ? null : emoji;
			if (current?.pending) {
				entries.set(id, { ...current, wish: target, shown: withUserEmoji(current.shown, target) });
				emit();
				return Promise.resolve();
			}
			const confirmed = current?.confirmed ?? current?.shown ?? EMPTY;
			put(id, { shown: withUserEmoji(current?.shown, target), confirmed, pending: true });
			return run(id, target);
		},
		reset() {
			entries.clear();
			emit();
		},
	};
}

export const messageReactions = createReactionStore(
	{
		set: setMessageReaction,
		clear: clearMessageReaction,
		get: getMessageReactions,
	},
	(message) => {
		toast.error(message);
	},
);

/** Reações exibidas de uma fala (otimistas ou confirmadas). */
export function useMessageReactions(messageId: string): readonly MessageReaction[] {
	return useSyncExternalStore(
		messageReactions.subscribe,
		() => messageReactions.get(messageId) ?? EMPTY,
		() => EMPTY,
	);
}
