import type { Message } from "@/components/ui/templates/template-4/data";
import { dedupeCards, reconcilePersistedThread } from "./thread-merge";

/**
 * Regra única de ressincronização do chat: o servidor é a fonte da verdade. Sempre que a conversa é
 * aberta, o app volta ao primeiro plano ou um run termina (por qualquer fonte), busca-se o fim da
 * conversa no servidor e reconcilia-se com o que está na tela, sem esperar o stream.
 */

function isLocalAssistantBubble(message: Message, persistedIds: Set<string>): boolean {
	return message.kind === "assistant" && !persistedIds.has(message.id);
}

/**
 * Funde o fim persistido da conversa (`tail`) na thread local. Sem run vivo, qualquer balão de assistente
 * local (placeholder do stream, resultado sintético) cujo texto já veio persistido sai: vale o do servidor.
 */
export function applyServerTail(
	live: Message[],
	tail: Message[],
	options: { runLive: boolean; resultText?: string | null },
): Message[] {
	const merged = reconcilePersistedThread(tail, live, options.resultText);
	if (options.runLive) return merged;
	const persistedIds = new Set(tail.map((message) => message.id));
	const persistedTexts = tail
		.filter((message) => message.kind === "assistant")
		.map((message) => (message.kind === "assistant" ? message.text.trim() : ""))
		.filter(Boolean);
	if (persistedTexts.length === 0) return merged;
	// O servidor grava um parágrafo/linha por mensagem; a bolha local tem a resposta inteira.
	const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
	const persistedBlob = squash(persistedTexts.join(" "));
	const cleaned = merged.filter((message) => {
		if (!isLocalAssistantBubble(message, persistedIds) || message.kind !== "assistant") return true;
		const text = message.text.trim();
		if (!text) return true;
		return !persistedTexts.some((persisted) => persisted.includes(text)) && !persistedBlob.includes(squash(text));
	});
	return cleaned.length === merged.length ? merged : dedupeCards(cleaned);
}

export type ThreadSyncDeps = {
	/** Fim persistido da conversa, na ordem cronológica. */
	fetchTail: (limit: number) => Promise<Message[]>;
	apply: (update: (previous: Message[]) => Message[]) => void;
	/** A conversa ainda é a que está na tela (e o efeito não foi desmontado). */
	isCurrent: () => boolean;
	wait?: (ms: number) => Promise<void>;
};

export type ThreadSyncOptions = {
	runLive: boolean;
	/** Resultado do run terminado: a sincronização insiste até a mensagem persistida aparecer. */
	resultText?: string | null;
	limit?: number;
	retries?: number;
	retryDelayMs?: number;
};

export type ThreadSync = {
	sync: (options: ThreadSyncOptions) => Promise<boolean>;
};

function containsResult(tail: Message[], resultText: string | null | undefined): boolean {
	const text = resultText?.trim();
	if (!text) return true;
	return tail.some((message) => message.kind === "assistant" && message.text.includes(text));
}

/**
 * Uma instância por conversa aberta. Respostas fora de ordem (uma busca antiga que termina depois de uma
 * nova) são descartadas: aplicar um fim desatualizado apagaria a mensagem que a busca nova já trouxe.
 */
export function createThreadSync(deps: ThreadSyncDeps): ThreadSync {
	let started = 0;
	let applied = 0;
	const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	return {
		async sync(options) {
			const ticket = ++started;
			const retries = options.retries ?? 0;
			const delay = options.retryDelayMs ?? 1_500;
			for (let attempt = 0; attempt <= retries; attempt += 1) {
				if (!deps.isCurrent()) return false;
				let tail: Message[] | null = null;
				try {
					tail = await deps.fetchTail(options.limit ?? 50);
				} catch {
					tail = null;
				}
				if (!deps.isCurrent()) return false;
				const complete = tail !== null && (options.runLive || containsResult(tail, options.resultText));
				if (tail !== null && (complete || attempt === retries)) {
					if (ticket < applied) return false;
					applied = ticket;
					const fetched = tail;
					deps.apply((previous) => applyServerTail(previous, fetched, options));
					return true;
				}
				if (attempt < retries) await wait(delay);
			}
			return false;
		},
	};
}
