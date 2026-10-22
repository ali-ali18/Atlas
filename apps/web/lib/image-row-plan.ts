/** Planejador da fileira justificada de imagens (mesma altura, largura = altura x aspecto). */
export const ROW_HEIGHT = 192;
export const ROW_MIN_HEIGHT = 64;
export const ROW_GAP = 6;
export const ROW_MAX_FOLDED_TILES = 3;
const DEFAULT_ASPECT = 4 / 3;

export type RowSize = { width?: number; height?: number } | undefined;
export type RowTile = { index: number; width: number; height: number };
export type RowPlan = {
	height: number;
	tiles: RowTile[];
	/** Quantas imagens a última tile representa ("+N"); 0 = nada dobrado. */
	foldedCount: number;
};

const valid = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function aspectOf(size: RowSize): number {
	return valid(size?.width) && valid(size?.height) ? size.width / size.height : DEFAULT_ASPECT;
}

/** Teto de altura da imagem: altura natural entre 64 e 192 (desconhecida = 192). */
function capOf(size: RowSize): number {
	return valid(size?.height) ? Math.min(ROW_HEIGHT, Math.max(ROW_MIN_HEIGHT, size.height)) : ROW_HEIGHT;
}

export function planImageRow({ sizes, availableWidth, gap = ROW_GAP }: { sizes: readonly RowSize[]; availableWidth: number; gap?: number }): RowPlan {
	const count = sizes.length;
	if (count === 0) return { height: 0, tiles: [], foldedCount: 0 };
	const avail = Math.max(1, availableWidth);
	const aspects = sizes.map(aspectOf);
	const base = Math.min(...sizes.map(capOf));
	const tileAt = (index: number, height: number): RowTile => ({ index, height, width: Math.min(Math.round(height * aspects[index]!), avail) });

	const all = aspects.map((_, index) => tileAt(index, base));
	if (all.reduce((sum, tile) => sum + tile.width, 0) + gap * (count - 1) <= avail) return { height: base, tiles: all, foldedCount: 0 };

	for (let c = Math.min(ROW_MAX_FOLDED_TILES, count); c >= 2; c -= 1) {
		const aspectSum = aspects.slice(0, c).reduce((sum, value) => sum + value, 0);
		let height = Math.min(base, Math.floor((avail - gap * (c - 1)) / aspectSum));
		const tiles = (h: number) => aspects.slice(0, c).map((_, index) => tileAt(index, h));
		const total = (h: number) => tiles(h).reduce((sum, tile) => sum + tile.width, 0) + gap * (c - 1);
		// O arredondamento de cada largura pode estourar em 1px por tile: baixa a altura até caber.
		while (height >= ROW_MIN_HEIGHT && total(height) > avail) height -= 1;
		if (height >= ROW_MIN_HEIGHT) return { height, tiles: tiles(height), foldedCount: c < count ? count - (c - 1) : 0 };
	}
	return { height: base, tiles: [tileAt(0, base)], foldedCount: count > 1 ? count : 0 };
}
