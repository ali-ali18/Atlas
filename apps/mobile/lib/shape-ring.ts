// Grade de formas e cores do "Criar novo Bot" e do editor de avatar: o contorno da forma escolhida, o tamanho da célula
// que o comporta inteiro e a montagem das linhas. Puro (testado em shape-ring.test.ts).

/** O contorno da forma escolhida segue a silhueta a uma distância fixa: respiro e traço, em pt na tela. */
export const RING_GAP_PT = 2;
export const RING_STROKE_PT = 2;

/** Caixa do motor (viewBox 0 0 250 250). O contorno passa da silhueta: o desenho ganha esta margem de cada lado, em unidades do motor. */
export const ENGINE_BOX = 250;
export const RING_PAD_UNITS = 30;

/**
 * Larguras de traço, em unidades do motor, para um avatar de `size` pt. O traço é centrado no caminho, então metade
 * dele fica fora da silhueta: `outer` vai até a borda de fora do contorno, `gap` só até o fim do respiro.
 */
export function ringStrokes(size: number): { outer: number; gap: number } {
	const unitsPerPt = ENGINE_BOX / size;
	return { outer: 2 * (RING_GAP_PT + RING_STROKE_PT) * unitsPerPt, gap: 2 * RING_GAP_PT * unitsPerPt };
}

/** Lado, em pt, da caixa onde o contorno é desenhado para um avatar de `size` pt: o contorno inteiro cabe, sem recorte. */
export const ringBoxSize = (size: number): number => (size * (ENGINE_BOX + 2 * RING_PAD_UNITS)) / ENGINE_BOX;

/** Menor célula tocável que comporta o contorno inteiro de um avatar de `size` pt, com folga. */
export const minCellFor = (size: number): number => Math.ceil(ringBoxSize(size)) + 2;

/** Avatar e célula das formas no "Criar novo Bot" (5 por linha cabem até em tela de 320 pt: 5 x 57 = 285). */
export const GRID_SHAPE_SIZE = 44;
export const GRID_SHAPE_CELL = minCellFor(GRID_SHAPE_SIZE);
/** Avatar e célula das formas no editor de avatar. */
export const EDITOR_SHAPE_SIZE = 48;
export const EDITOR_SHAPE_CELL = minCellFor(EDITOR_SHAPE_SIZE);

/** Quantas formas aparecem recolhidas: 3 linhas de 5. */
export const SHAPES_PER_ROW = 5;
export const COLLAPSED_SHAPES = 3 * SHAPES_PER_ROW;
export const COLORS_PER_ROW = 6;

/** Formas visíveis: as 3 primeiras linhas, ou todas quando expandido. */
export function visibleShapes<T>(all: readonly T[], expanded: boolean): T[] {
	return expanded ? [...all] : all.slice(0, COLLAPSED_SHAPES);
}

/** A forma escolhida precisa estar à vista: se está depois da 3a linha, a grade abre já expandida. */
export const needsExpanded = (all: readonly unknown[], selected: unknown): boolean => all.indexOf(selected) >= COLLAPSED_SHAPES;

/** Linhas de `perRow` itens; a última completa com `null` (espaço), para ficar na mesma grade, sem buraco no meio. */
export function chunkRows<T>(items: readonly T[], perRow: number): (T | null)[][] {
	const rows: (T | null)[][] = [];
	for (let start = 0; start < items.length; start += perRow) {
		const row: (T | null)[] = items.slice(start, start + perRow);
		while (row.length < perRow) row.push(null);
		rows.push(row);
	}
	return rows;
}
