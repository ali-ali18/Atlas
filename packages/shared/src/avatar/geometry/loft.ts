// Superfície da almofada (nuvem, coração): altura z em função de (x, y).
import { BODY_RADIUS_PX } from "./shapes.js";
import { LOFT_EXPONENT, type SolidKind, type WorldOutline } from "./solid.js";

type Loft = Extract<SolidKind, { type: "loft" }>;

const LOFT_ANGLES = 180;


/**
 * Altura da almofada em (x, y): z = profundidade · √(1 − ρ^(2/0,72)), com ρ a
 * distância ao centro dividida pelo raio do contorno naquela direção. É a
 * mesma superfície dos anéis de `loftRings`.
 */
export function loftSurface(world: WorldOutline, kind: Loft): (x: number, y: number) => number {
	const depth = kind.depth * BODY_RADIUS_PX;
	const radial = new Float64Array(LOFT_ANGLES);
	for (let a = 0; a < LOFT_ANGLES; a++) {
		const theta = ((a + 0.5) / LOFT_ANGLES) * Math.PI * 2;
		const ux = Math.cos(theta);
		const uy = Math.sin(theta);
		let best = 0;
		for (let i = 0; i < world.count; i++) {
			const j = (i + 1) % world.count;
			const x0 = (world.pts[i * 2] as number) - world.cx;
			const y0 = (world.pts[i * 2 + 1] as number) - world.cy;
			const ex = (world.pts[j * 2] as number) - world.cx - x0;
			const ey = (world.pts[j * 2 + 1] as number) - world.cy - y0;
			const denom = ux * ey - uy * ex;
			if (Math.abs(denom) < 1e-9) continue;
			const t = (x0 * ey - y0 * ex) / denom;
			const s = (x0 * uy - y0 * ux) / denom;
			if (t > best && s >= 0 && s <= 1) best = t;
		}
		radial[a] = best;
	}
	return (x, y) => {
		const px = x - world.cx;
		const py = y - world.cy;
		const dist = Math.hypot(px, py);
		if (dist < 1e-8) return depth;
		const f = (((Math.atan2(py, px) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * LOFT_ANGLES - 0.5;
		const i = ((Math.floor(f) % LOFT_ANGLES) + LOFT_ANGLES) % LOFT_ANGLES;
		const frac = f - Math.floor(f);
		const edge = (radial[i] as number) * (1 - frac) + (radial[(i + 1) % LOFT_ANGLES] as number) * frac;
		const rho = Math.min(1, dist / Math.max(1e-8, edge));
		return depth * Math.sqrt(Math.max(0, 1 - rho ** (2 / LOFT_EXPONENT)));
	};
}
