/**
 * Lógica pura do arraste da gaveta (bottom sheet): decide a altura durante o dedo e onde ela assenta ao soltar.
 * Sem React nem animação, para testar os limites. Convenção: `dy` positivo = dedo para baixo; `vy` em px/ms
 * (positivo = para baixo). A gaveta mora ancorada embaixo, então arrastar para cima AUMENTA a altura.
 */

export type SheetRest = "collapsed" | "expanded";
export type SheetNext = "closed" | "collapsed" | "expanded";

export type SheetHeights = {
	/** Altura inicial: a do conteúdo, limitada a ~60% da tela. */
	collapsed: number;
	/** Altura máxima: tela menos o topo seguro e a folga. Sempre ≥ `collapsed`. */
	expanded: number;
};

/** Velocidade (px/ms) a partir da qual o gesto vira arremesso e ignora a distância. */
export const FLING_VELOCITY = 0.5;
/** Quanto do deslocamento além do limite superior ainda "acompanha" o dedo (resistência elástica). */
export const OVERSCROLL_RESISTANCE = 0.15;

/** Altura da folha no estado de repouso. */
export function restHeight(rest: SheetRest, { collapsed, expanded }: SheetHeights): number {
	return rest === "expanded" ? Math.max(collapsed, expanded) : collapsed;
}

/** Altura enquanto o dedo arrasta: nunca negativa e, além da expandida, só uma fração do deslocamento. */
export function dragHeight(from: SheetRest, dy: number, heights: SheetHeights): number {
	const max = Math.max(heights.collapsed, heights.expanded);
	const raw = restHeight(from, heights) - dy;
	if (raw <= 0) return 0;
	if (raw <= max) return raw;
	return max + (raw - max) * OVERSCROLL_RESISTANCE;
}

/** Próximo estado e altura alvo ao soltar o dedo. */
export function settleSheet(from: SheetRest, dy: number, vy: number, heights: SheetHeights): { next: SheetNext; height: number } {
	const collapsed = Math.max(0, heights.collapsed);
	const expanded = Math.max(collapsed, heights.expanded);
	const to = (next: SheetNext) => ({ next, height: next === "closed" ? 0 : next === "expanded" ? expanded : collapsed });

	// Arremesso: a direção manda, a distância não importa.
	if (vy <= -FLING_VELOCITY) return to("expanded");
	if (vy >= FLING_VELOCITY) return to(from === "collapsed" ? "closed" : "collapsed");

	const height = dragHeight(from, dy, { collapsed, expanded });
	// Abaixo da metade da altura inicial: fecha.
	if (height < collapsed / 2) return to("closed");
	// Entre a colapsada e a expandida decide pela metade do caminho (empate fica onde está).
	const middle = (collapsed + expanded) / 2;
	if (height > middle) return to("expanded");
	if (height < middle) return to("collapsed");
	return to(from);
}

/** A folha tem uma altura só (inicial = máxima), como a de conteúdo. */
export function isSingleHeight({ collapsed, expanded }: SheetHeights): boolean {
	return expanded <= collapsed;
}

/** Estado de repouso depois de assentar: com altura única "expanded" não existe (senão o arremesso para baixo viraria "recolher" e não fecharia). */
export function normalizeRest(next: SheetRest, heights: SheetHeights): SheetRest {
	return isSingleHeight(heights) ? "collapsed" : next;
}

/** Toque na alça: alterna as duas alturas; com altura única não muda nada. */
export function tapRest(from: SheetRest, heights: SheetHeights): SheetRest {
	if (isSingleHeight(heights)) return "collapsed";
	return from === "collapsed" ? "expanded" : "collapsed";
}
