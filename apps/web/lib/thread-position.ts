/**
 * Posição da conversa: onde ela pousa ao entrar, onde fica a linha "Novas mensagens",
 * e se uma mensagem nova segue o fim ou vira a pílula "↓ N novas". Funções puras.
 */

/** Distância do fim (px) até a qual o usuário conta como "grudado no fim". */
export const PINNED_THRESHOLD_PX = 120;
/** Quantas páginas de histórico buscar para achar a primeira não lida antes de desistir. */
export const MAX_OLDER_LOADS_FOR_ANCHOR = 6;
/** Depois de pousar, o layout pode mudar (markdown, imagens, histórico): re-ancora por este tempo. */
export const LANDING_LOCK_MS = 2500;
/** Espaço acima da linha "Novas mensagens", abaixo do cabeçalho fixo. */
export const DIVIDER_HEADROOM_PX = 96;

export function isPinned(distanceFromBottom: number): boolean {
	return distanceFromBottom < PINNED_THRESHOLD_PX;
}

export type ArrivalDecision = "none" | "follow" | "pill";

/** Mensagens novas no fim: grudado segue o fim; quem subiu para ler recebe a pílula (sem puxar a tela). */
export function decideArrival(input: { newMessages: number; pinned: boolean }): ArrivalDecision {
	if (input.newMessages <= 0) return "none";
	return input.pinned ? "follow" : "pill";
}

/**
 * Onde fica a linha "Novas mensagens": exatamente antes da primeira mensagem VISÍVEL que o usuário
 * ainda não viu. A âncora do servidor pode ser uma mensagem escondida (protocolo de cartão, balão
 * vazio, ferramenta): nesse caso vale a próxima visível, na ordem da conversa.
 * Devolve null quando a âncora não está na lista carregada ou nada visível a segue.
 */
export function resolveDividerAnchor(
	allIds: readonly string[],
	visibleIds: ReadonlySet<string> | readonly string[],
	anchorId: string | null | undefined,
): string | null {
	if (!anchorId) return null;
	const visible = visibleIds instanceof Set ? visibleIds : new Set(visibleIds);
	const start = allIds.indexOf(anchorId);
	if (start < 0) return null;
	for (let index = start; index < allIds.length; index += 1) {
		const id = allIds[index]!;
		if (visible.has(id)) return id;
	}
	return null;
}

export type LandingDecision =
	| { kind: "bottom" }
	| { kind: "divider"; messageId: string }
	| { kind: "load-older" };

/**
 * Decisão de pouso ao entrar: sem não lidas -> fim; com não lidas -> a linha "Novas mensagens";
 * âncora mais antiga que o histórico carregado -> busca páginas anteriores (limitado).
 */
export function decideLanding(input: {
	anchorId: string | null;
	allIds: readonly string[];
	visibleIds: ReadonlySet<string> | readonly string[];
	hasMoreHistory: boolean;
	olderLoads: number;
}): LandingDecision {
	if (!input.anchorId) return { kind: "bottom" };
	if (!input.allIds.includes(input.anchorId)) {
		return input.hasMoreHistory && input.olderLoads < MAX_OLDER_LOADS_FOR_ANCHOR ? { kind: "load-older" } : { kind: "bottom" };
	}
	const resolved = resolveDividerAnchor(input.allIds, input.visibleIds, input.anchorId);
	return resolved ? { kind: "divider", messageId: resolved } : { kind: "bottom" };
}

/** scrollTop do pouso. `dividerTop` = topo da linha relativo ao conteúdo rolável. */
export function landingScrollTop(input: {
	target: "bottom" | "divider";
	scrollHeight: number;
	clientHeight: number;
	dividerTop?: number;
	headroom?: number;
}): number {
	const max = Math.max(0, input.scrollHeight - input.clientHeight);
	if (input.target === "bottom") return max;
	const wanted = (input.dividerTop ?? 0) - (input.headroom ?? DIVIDER_HEADROOM_PX);
	return Math.min(max, Math.max(0, Math.round(wanted)));
}

/** Re-ancora depois do pouso enquanto o conteúdo se acomoda e o usuário ainda não mexeu na rolagem. */
export function shouldReanchor(input: { elapsedMs: number; userInteracted: boolean }): boolean {
	return !input.userInteracted && input.elapsedMs >= 0 && input.elapsedMs <= LANDING_LOCK_MS;
}

/**
 * Voltou de segundo plano: a primeira mensagem do assistente que chegou depois da última vista
 * antes de sair.
 */
export function resumeAnchorId(
	messages: ReadonlyArray<{ id: string; kind: string }>,
	awayTailId: string | null,
): string | null {
	const from = awayTailId ? messages.findIndex((message) => message.id === awayTailId) : -1;
	if (awayTailId && from < 0) return null;
	return messages.slice(from + 1).find((message) => message.kind === "assistant")?.id ?? null;
}
