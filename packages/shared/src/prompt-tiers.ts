import type { ChatMessage } from "./chat.js";

/**
 * F2 — prompt em tiers. O provider cacheia por PREFIXO: o que muda a cada pedido
 * não pode vir antes do histórico.
 *
 *   stable   → prompt do sistema (identidade, regras, tools, skills): fixo por bot.
 *   context  → perfil, identidade do bot, resumo: muda raramente, vem antes do histórico.
 *   volatile → o que depende do pedido atual (memória por relevância, trechos de
 *              conversas passadas): vai colado ao turno, DEPOIS do histórico.
 */
export type PromptTier = "stable" | "context" | "volatile";

/** Bloco `system` com o texto já renderizado; vazio é descartado. */
function systemBlocks(texts: ReadonlyArray<string | null | undefined>): ChatMessage[] {
	return texts.flatMap((text) => (text && text.trim() ? [{ role: "system" as const, content: text }] : []));
}

/**
 * Monta `context → histórico → volatile → turno`. O `turn` é a última mensagem
 * do usuário; os blocos voláteis ficam logo antes dela, de modo que o prefixo
 * `context + histórico` é idêntico entre pedidos da mesma conversa.
 */
export function composeTieredMessages(input: {
	context: ReadonlyArray<string | null | undefined>;
	history: readonly ChatMessage[];
	volatile: ReadonlyArray<string | null | undefined>;
	turn?: ChatMessage;
}): ChatMessage[] {
	return [
		...systemBlocks(input.context),
		...input.history,
		...systemBlocks(input.volatile),
		...(input.turn ? [input.turn] : []),
	];
}

/**
 * Inserção de blocos voláteis em uma lista já montada: antes da última mensagem
 * quando ela é do usuário, senão no fim. Nunca no início.
 */
export function placeVolatileBeforeTurn(
	messages: readonly ChatMessage[],
	volatile: ReadonlyArray<string | null | undefined>,
): ChatMessage[] {
	const blocks = systemBlocks(volatile);
	if (blocks.length === 0) return [...messages];
	const last = messages[messages.length - 1];
	if (last?.role !== "user") return [...messages, ...blocks];
	return [...messages.slice(0, -1), ...blocks, last];
}

/** Razão cache/prompt de uma soma de tokens; `null` sem prompt medido. */
export function cacheHitRatio(tokens: { prompt: number; cached: number }): number | null {
	if (!(tokens.prompt > 0)) return null;
	return Math.min(1, Math.max(0, tokens.cached / tokens.prompt));
}
