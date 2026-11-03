// Layout do painel, parte pura. O web decide por largura do CONTÊINER (`@md`/`@2xl`); aqui é a largura medida da própria
// grade (`onLayout`), então grade dentro de card estreito também se ajusta. Celular = 1 coluna (grade só de `stat` = 2);
// tablet e paisagem seguem as colunas do spec.
import type { PageGap } from "@workspace/shared";

/** Espaço entre itens (pt), as mesmas três medidas do web (gap-2, gap-3, gap-5). */
export const GAP_PX: Record<PageGap, number> = { sm: 8, md: 12, lg: 20 };

/** Equivalentes de `@md` (28rem) e `@2xl` (42rem) do web. */
export const BREAKPOINT_MD = 448;
export const BREAKPOINT_2XL = 672;

export const gapPx = (gap: PageGap | undefined): number => GAP_PX[gap ?? "md"];

/** Grade só de `stat`: os tiles são curtos e uma coluna só vira uma fila longa de números. */
export function isStatsOnly(types: readonly string[]): boolean {
	return types.length > 0 && types.every((type) => type === "stat");
}

/** Quantas colunas cabem em `width` (0 = ainda não medido: 1). `cols` é o pedido do spec (1 a 4). */
export function gridColumns(cols: number, width: number, statsOnly: boolean): number {
	const wanted = Math.min(4, Math.max(1, Math.floor(cols) || 1));
	if (!(width > 0)) return 1;
	if (statsOnly) return width < BREAKPOINT_2XL ? Math.min(wanted, 2) : wanted;
	if (width < BREAKPOINT_MD) return 1;
	if (width < BREAKPOINT_2XL) return Math.min(wanted, 2);
	return wanted;
}

/**
 * Tamanho do valor de um stat pelo tamanho pedido e pelo comprimento do texto. `adjustsFontSizeToFit` só existe no
 * nativo (a prévia web e alguns aparelhos ignoram), então o texto longo ("R$ 128.450,50") já nasce menor, em vez de
 * cortar com reticências.
 */
export function statFontSize(base: number, textLength: number): number {
	if (textLength > 12) return Math.round(base * 0.65);
	if (textLength > 9) return Math.round(base * 0.8);
	return base;
}

/** Kanban: colunas lado a lado a partir da largura de tablet/paisagem; abaixo disso empilham, cada uma recolhível. */
export function kanbanLayout(width: number): "stacked" | "columns" {
	return width >= BREAKPOINT_2XL ? "columns" : "stacked";
}

/** `span` do filho dentro da grade: de 1 até o número de colunas visíveis. */
export function clampSpan(span: unknown, columns: number): number {
	const wanted = typeof span === "number" && Number.isFinite(span) ? Math.floor(span) : 1;
	return Math.min(columns, Math.max(1, wanted));
}

/** Largura em pt de um item que ocupa `span` colunas (arredonda para baixo: nunca estoura a linha por meio pixel). */
export function gridItemWidth(total: number, columns: number, gap: number, span: number): number {
	if (!(total > 0) || columns < 1) return 0;
	const column = (total - gap * (columns - 1)) / columns;
	return Math.floor(column * span + gap * (span - 1));
}
