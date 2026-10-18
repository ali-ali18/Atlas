// Corpo como sólido 3D. O contorno 2D de cada forma vira um sólido por um de
// três métodos (os do app de referência):
//  - esfera (blob): silhueta sempre um círculo;
//  - revolução: o contorno gira em torno do eixo vertical (ou horizontal, no
//    tablet) e a silhueta é o casco convexo da superfície projetada;
//  - extrusão: frente e fundo ligados por faces laterais, com borda chanfrada
//    (anéis recuados) para a espessura não parecer uma chapa;
//  - almofada (loft): anéis do mesmo contorno encolhendo com cos^0,72.
// As faces de trás são descartadas e as da frente se unem num único path.
import { BODY_RADIUS_PX, CENTER, type Shape } from "./shapes.js";

export type SolidKind =
	| { type: "sphere" }
	| { type: "revolve"; axis: "x" | "y" }
	/** `halfDepth` e `bevel` em raios do corpo. */
	| { type: "extrusion"; halfDepth: number; bevel: number }
	| { type: "loft"; depth: number };

const SLAB = { type: "extrusion", halfDepth: 0.36, bevel: 0.22 } as const;
const REVOLVE = { type: "revolve", axis: "y" } as const;

/** Tabela do app de referência (profundidades e chanfros por forma). */
export const SOLID_KIND: Record<Shape, SolidKind> = {
	blob: { type: "sphere" },
	pebble: REVOLVE,
	bean: REVOLVE,
	egg: REVOLVE,
	squircle: { type: "extrusion", halfDepth: 0.28, bevel: 0.11 },
	tablet: { type: "revolve", axis: "x" },
	capsule: REVOLVE,
	cylinder: REVOLVE,
	hex: SLAB,
	gem: REVOLVE,
	crystal: REVOLVE,
	wedge: REVOLVE,
	shield: REVOLVE,
	dome: REVOLVE,
	arch: REVOLVE,
	cloud: { type: "loft", depth: 0.72 },
	teardrop: REVOLVE,
	leaf: REVOLVE,
	square: SLAB,
	sparkle: SLAB,
	clover: SLAB,
	flower: SLAB,
	heart: { type: "loft", depth: 0.62 },
	house: SLAB,
	star: { type: "extrusion", halfDepth: 0.3, bevel: 0.18 },
};

// ------------------------------------------------------------------ contorno

/** Contorno no espaço do mundo: px do viewBox, origem no centro, y para cima. */
export type WorldOutline = {
	/** [x0, y0, x1, y1, …] */
	pts: Float64Array;
	count: number;
	/** Centro do retângulo envolvente. */
	cx: number;
	cy: number;
	/** Menor semi-extensão do retângulo envolvente. */
	halfMin: number;
	minY: number;
	maxY: number;
	minX: number;
	maxX: number;
};

/**
 * `stride` pula pontos (2 = metade): os sólidos projetam muitas faces por
 * quadro, então usam um contorno mais ralo (48 pontos); a silhueta de frente
 * continua usando o contorno inteiro.
 */
export function worldOutline(outline: readonly number[], stride = 1): WorldOutline {
	const count = Math.floor(outline.length / 2 / stride);
	const pts = new Float64Array(outline.length);
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < count; i++) {
		const x = (outline[i * stride * 2] as number) - CENTER;
		const y = CENTER - (outline[i * stride * 2 + 1] as number);
		pts[i * 2] = x;
		pts[i * 2 + 1] = y;
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	return {
		pts,
		count,
		cx: (minX + maxX) / 2,
		cy: (minY + maxY) / 2,
		halfMin: Math.max(1e-4, Math.min(maxX - minX, maxY - minY) / 2),
		minX,
		maxX,
		minY,
		maxY,
	};
}

// -------------------------------------------------------------------- anéis

export type Ring = { z: number; scale: number };

const BEVEL_STEPS = 2;
const LOFT_STEPS = 10;
export const LOFT_EXPONENT = 0.72;

/**
 * Anéis de baixo (fundo) para cima (frente). Extrusão: quarto de círculo de
 * chanfro em cada lado (z = t − n + n·sen p, escala = 1 − n/u·(1 − cos p)),
 * como no app de referência; `z` em px, `scale` em torno do centro do contorno.
 */
export function extrusionRings(kind: Extrusion, halfMin: number): Ring[] {
	const t = kind.halfDepth * BODY_RADIUS_PX;
	const n = kind.bevel * BODY_RADIUS_PX;
	const u = halfMin;
	const side = (h: number, sign: 1 | -1): Ring => {
		const p = (h / BEVEL_STEPS) * (Math.PI / 2);
		return {
			z: sign * (t - n + n * Math.sin(p)),
			scale: Math.max(0, 1 - (n / u) * (1 - Math.cos(p))),
		};
	};
	const rings: Ring[] = [];
	for (let h = BEVEL_STEPS; h >= 0; h--) rings.push(side(h, -1));
	for (let h = 0; h <= BEVEL_STEPS; h++) rings.push(side(h, 1));
	return rings;
}

/** Almofada: latitudes de −90° a 90°, escala cos^0,72 e z = profundidade · sen. */
export function loftRings(kind: Loft): Ring[] {
	const depth = kind.depth * BODY_RADIUS_PX;
	const rings: Ring[] = [];
	for (let l = 0; l <= LOFT_STEPS; l++) {
		const phi = -Math.PI / 2 + (Math.PI * l) / LOFT_STEPS;
		rings.push({ z: depth * Math.sin(phi), scale: Math.max(0, Math.cos(phi)) ** LOFT_EXPONENT });
	}
	return rings;
}

type Extrusion = Extract<SolidKind, { type: "extrusion" }>;
type Loft = Extract<SolidKind, { type: "loft" }>;

// ---------------------------------------------------------------- revolução

/** Semilargura do contorno por altura (ou por posição, no eixo x). */
export type Profile = {
	axis: "x" | "y";
	/** Início e fim do eixo (px) e amostras de raio em passos iguais. */
	lo: number;
	hi: number;
	radius: Float64Array;
};

const PROFILE_ROWS = 160;

/**
 * Perfil de revolução: para cada altura, metade da largura do contorno (do
 * cruzamento mais à esquerda ao mais à direita). Revolução em torno de x usa a
 * altura em função de x.
 */
export function revolveProfile(world: WorldOutline, axis: "x" | "y"): Profile {
	const along = axis === "y" ? 1 : 0;
	const across = 1 - along;
	const lo = axis === "y" ? world.minY : world.minX;
	const hi = axis === "y" ? world.maxY : world.maxX;
	const radius = new Float64Array(PROFILE_ROWS);
	const span = hi - lo || 1;
	for (let row = 0; row < PROFILE_ROWS; row++) {
		const at = lo + (span * (row + 0.5)) / PROFILE_ROWS;
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < world.count; i++) {
			const j = (i + 1) % world.count;
			const a0 = world.pts[i * 2 + along] as number;
			const a1 = world.pts[j * 2 + along] as number;
			if (a0 <= at === a1 <= at) continue;
			const v =
				(world.pts[i * 2 + across] as number) +
				(((world.pts[j * 2 + across] as number) - (world.pts[i * 2 + across] as number)) * (at - a0)) / (a1 - a0);
			if (v < min) min = v;
			if (v > max) max = v;
		}
		radius[row] = Number.isFinite(min) ? Math.max(0, (max - min) / 2) : 0;
	}
	return { axis, lo, hi, radius };
}

/** Raio do perfil na posição `at` (interpolado; fora do corpo = 0). */
export function profileRadius(profile: Profile, at: number): number {
	const span = profile.hi - profile.lo || 1;
	const f = ((at - profile.lo) / span) * PROFILE_ROWS - 0.5;
	const i = Math.max(0, Math.min(PROFILE_ROWS - 1, Math.floor(f)));
	const j = Math.min(PROFILE_ROWS - 1, i + 1);
	const t = Math.max(0, Math.min(1, f - i));
	return (profile.radius[i] as number) * (1 - t) + (profile.radius[j] as number) * t;
}

/** Inclinação dr/d(posição) do perfil (para a normal da superfície). */
export function profileSlope(profile: Profile, at: number): number {
	const h = ((profile.hi - profile.lo) / PROFILE_ROWS) * 2;
	return (profileRadius(profile, at + h) - profileRadius(profile, at - h)) / (2 * h);
}

const REVOLVE_ROWS = 16;
const REVOLVE_ANGLES = 24;

/**
 * Pontos 3D da superfície de revolução ([x, y, z, …]). As linhas seguem o
 * cosseno (mais pontos nos polos). Eixo y: (r·sen θ, y, r·cos θ); eixo x:
 * (x, r·sen θ, r·cos θ).
 */
export function revolveSamples(profile: Profile): Float64Array {
	const out = new Float64Array(REVOLVE_ROWS * REVOLVE_ANGLES * 3);
	let k = 0;
	for (let row = 0; row < REVOLVE_ROWS; row++) {
		const f = (1 - Math.cos((Math.PI * row) / (REVOLVE_ROWS - 1))) / 2;
		const at = profile.lo + (profile.hi - profile.lo) * f;
		const r = profileRadius(profile, at);
		for (let a = 0; a < REVOLVE_ANGLES; a++) {
			const theta = (a / REVOLVE_ANGLES) * Math.PI * 2;
			const s = r * Math.sin(theta);
			const c = r * Math.cos(theta);
			if (profile.axis === "y") {
				out[k++] = s;
				out[k++] = at;
				out[k++] = c;
			} else {
				out[k++] = at;
				out[k++] = s;
				out[k++] = c;
			}
		}
	}
	return out;
}

// ------------------------------------------------------------- casco convexo

/** Casco convexo (cadeia monótona) de pontos [x, y, …]; devolve anti-horário (y para cima). */
export function convexHull(points: ArrayLike<number>): number[] {
	const n = points.length / 2;
	const order = Array.from({ length: n }, (_, i) => i).sort(
		(a, b) =>
			(points[a * 2] as number) - (points[b * 2] as number) ||
			(points[a * 2 + 1] as number) - (points[b * 2 + 1] as number),
	);
	const cross = (o: number, a: number, b: number) =>
		((points[a * 2] as number) - (points[o * 2] as number)) *
			((points[b * 2 + 1] as number) - (points[o * 2 + 1] as number)) -
		((points[a * 2 + 1] as number) - (points[o * 2 + 1] as number)) *
			((points[b * 2] as number) - (points[o * 2] as number));
	const hull: number[] = [];
	for (const i of order) {
		while (hull.length >= 2 && cross(hull[hull.length - 2] as number, hull[hull.length - 1] as number, i) <= 1e-9) hull.pop();
		hull.push(i);
	}
	const lower = hull.length + 1;
	for (let k = order.length - 2; k >= 0; k--) {
		const i = order[k] as number;
		while (hull.length >= lower && cross(hull[hull.length - 2] as number, hull[hull.length - 1] as number, i) <= 1e-9) hull.pop();
		hull.push(i);
	}
	hull.pop();
	const out: number[] = [];
	for (const i of hull) out.push(points[i * 2] as number, points[i * 2 + 1] as number);
	return out;
}
