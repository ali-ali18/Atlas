// Utilitários de teste/diagnóstico: lê paths `M…L…Z` do motor (só linhas) e
// responde "este ponto está dentro?" pela regra não-zero (união de subcaminhos).
export type Point2 = readonly [number, number];

export function parseSubpaths(d: string): Point2[][] {
	const out: Point2[][] = [];
	for (const chunk of d.split("M")) {
		const nums = chunk.replace(/[LZ]/g, " ").trim().split(/\s+/).filter(Boolean).map(Number);
		if (nums.length < 6) continue;
		const poly: Point2[] = [];
		for (let i = 0; i + 1 < nums.length; i += 2) poly.push([nums[i] as number, nums[i + 1] as number]);
		out.push(poly);
	}
	return out;
}

/** Número de enrolamento (winding) de um ponto em relação a um polígono. */
function winding(x: number, y: number, poly: readonly Point2[]): number {
	let w = 0;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i] as Point2;
		const b = poly[(i + 1) % poly.length] as Point2;
		if (a[1] <= y) {
			if (b[1] > y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) > 0) w++;
		} else if (b[1] <= y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) < 0) w--;
	}
	return w;
}

/** Regra não-zero (a do SVG por padrão) sobre todos os subcaminhos. */
export function insideNonZero(x: number, y: number, polys: readonly (readonly Point2[])[]): boolean {
	let w = 0;
	for (const poly of polys) w += winding(x, y, poly);
	return w !== 0;
}

export function bounds(polys: readonly (readonly Point2[])[]) {
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const poly of polys) {
		for (const [x, y] of poly) {
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}
	return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}
