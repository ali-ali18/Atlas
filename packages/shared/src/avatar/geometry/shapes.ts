// Catálogo de formas: cada forma vira um contorno de N pontos fixos numa área
// de 250×250 (centro em 125,125), com o ponto 0 no topo e o sentido horário.
// Mesmo N e mesmo ponto de partida em todas as formas: é isso que permite o
// morph ponto a ponto. As formas são geradas por fórmula (superelipse, raio
// modulado, polígono com cantos arredondados, união de círculos); coração,
// brilho e estrela têm contorno livre e vêm pré-amostrados abaixo.
import { TAU, clamp } from "./math.js";

export const SHAPE_POINTS = 96;
export const AVATAR_BOX = 250;
export const CENTER = AVATAR_BOX / 2;
/** Tamanho (maior lado) que todo contorno ocupa depois de normalizado. */
const FIT = 228.44;
/** Raio (px do viewBox) do círculo normalizado: 1 "unidade de corpo". */
export const BODY_RADIUS_PX = 114.27;
/**
 * Fração do viewBox que o corpo ocupa. A folga (~25%) é para o giro 3D, o
 * squash, a respiração e o deslocamento dos clipes; a maior forma (a cunha)
 * chega a ~112 px do centro em ±30° de yaw/pitch.
 */
export const VIEW_FIT = 0.77;

/**
 * Enquadramento por forma (valores do app de referência): "tamanho" de cada
 * forma, onde o círculo vale 1,17. Formas pontudas ou estreitas crescem, as
 * que já ocupam o canto (quadrado, trevo) encolhem, para nenhuma parecer
 * maior que a outra. A referência tem esses valores fixos (não os calcula).
 */
const REFERENCE_SIZE: Partial<Record<Shape, number>> = {
	pebble: 1.2168,
	tablet: 1.3923,
	hex: 1.2519,
	crystal: 1.3806,
	wedge: 1.359072,
	teardrop: 1.318122,
	cloud: 1.3455,
	square: 1.0413,
	flower: 1.3923,
	sparkle: 1.521,
	clover: 1.0881,
	heart: 1.3572,
	star: 1.4976,
};
const BASE_SIZE = 1.17;

/** Escala relativa da forma (círculo = 1). */
export function shapeScale(shape: Shape): number {
	return (REFERENCE_SIZE[shape] ?? BASE_SIZE) / BASE_SIZE;
}

/** Escala da forma no viewBox: enquadramento · folga do viewBox. */
export function shapeFit(shape: Shape): number {
	return VIEW_FIT * shapeScale(shape);
}

/**
 * Escala que faria o pior ponto do contorno cair exatamente no raio do corpo
 * (enquadramento do plano, C7). Diagnóstico: o motor usa a tabela da
 * referência (`shapeScale`), que é ajustada à mão e não por esta conta.
 */
export function worstPointScale(shape: Shape): number {
	return BODY_RADIUS_PX / worstPointRadius(shapeOutline(shape));
}

/** Maior distância de um ponto do contorno ao centro (o "pior ponto"). */
export function worstPointRadius(outline: Outline): number {
	let max = 0;
	for (let i = 0; i < outline.length; i += 2) {
		max = Math.max(max, Math.hypot((outline[i] as number) - CENTER, (outline[i + 1] as number) - CENTER));
	}
	return max;
}

export type Point = readonly [number, number];
/** Contorno achatado: [x0, y0, x1, y1, ...] com SHAPE_POINTS pontos. */
export type Outline = readonly number[];

export const SHAPE_IDS = [
	"blob",
	"pebble",
	"bean",
	"egg",
	"squircle",
	"tablet",
	"capsule",
	"cylinder",
	"hex",
	"gem",
	"crystal",
	"wedge",
	"shield",
	"dome",
	"arch",
	"cloud",
	"teardrop",
	"leaf",
	"square",
	"sparkle",
	"clover",
	"flower",
	"heart",
	"house",
	"star",
] as const;

export type Shape = (typeof SHAPE_IDS)[number];

export function isShape(value: unknown): value is Shape {
	return typeof value === "string" && (SHAPE_IDS as readonly string[]).includes(value);
}

/** Formas que o sorteio por id pode escolher (as mais "limpas" com dois olhos). */
export const DRAWABLE_SHAPES: readonly Shape[] = [
	"blob",
	"pebble",
	"squircle",
	"tablet",
	"wedge",
	"hex",
	"cloud",
	"teardrop",
];

/** Contornos livres, já amostrados em 96 pontos (coordenadas brutas). */
const FREEFORM: Record<"heart" | "sparkle" | "star", number[]> = {
	heart: [73.4,17.6,76.6,14.4,79.9,11.2,83.4,8.4,87,5.8,91,3.7,95.2,2.1,99.6,0.8,104,0.3,108.5,0.1,113,0.5,117.4,1.5,121.8,2.8,125.8,4.8,129.7,7,133.2,9.9,136.5,13,139.3,16.5,141.7,20.3,143.8,24.3,145.2,28.6,146.3,32.9,146.7,37.4,146.6,41.9,146.2,46.4,145.1,50.8,143.6,55,141.5,59,139.1,62.8,136.2,66.3,133.1,69.6,129.9,72.8,126.8,76,123.6,79.2,120.4,82.4,117.2,85.6,114,88.8,110.8,92,107.6,95.2,104.4,98.3,101.2,101.5,98,104.7,94.8,107.9,91.6,111.1,88.4,114.3,85.2,117.5,81.9,120.5,77.9,122.6,73.4,123.3,69,122.6,65,120.5,61.6,117.5,58.5,114.3,55.3,111.1,52.1,107.9,48.9,104.7,45.7,101.5,42.5,98.3,39.3,95.2,36.1,92,32.9,88.8,29.7,85.6,26.5,82.4,23.3,79.2,20.1,76,16.9,72.8,13.7,69.6,10.7,66.3,7.8,62.8,5.4,59,3.3,55,1.8,50.8,0.7,46.4,0.2,41.9,0.2,37.4,0.6,32.9,1.7,28.6,3.1,24.3,5.2,20.3,7.6,16.5,10.4,13,13.7,9.9,17.2,7,21.1,4.8,25.1,2.8,29.4,1.5,33.8,0.5,38.3,0.1,42.8,0.3,47.3,0.8,51.6,2.1,55.9,3.7,59.9,5.8,63.5,8.4,67,11.2,70.2,14.4],
	sparkle: [78.9,7.7,83,4.5,87.5,1.9,92.5,0.3,97.7,0.1,102.7,1.6,106.9,4.6,110.3,8.6,112.9,13.1,114.8,18,116.1,23.1,117.1,28.2,117.8,33.4,118.1,38.6,118.3,43.8,118.2,49,117.9,54.3,120.4,57.8,125.1,60.1,129.7,62.7,134.1,65.4,138.4,68.4,142.6,71.6,146.5,75.1,150.1,78.8,153.3,83,155.8,87.5,157.4,92.5,157.6,97.7,156.1,102.7,153.1,107,149.1,110.3,144.6,112.9,139.7,114.8,134.7,116.2,129.5,117.1,124.4,117.8,119.1,118.1,113.9,118.3,108.7,118.2,103.5,117.9,100,120.4,97.6,125.1,95,129.6,92.3,134.1,89.3,138.4,86.1,142.5,82.7,146.5,78.9,150.1,74.7,153.3,70.2,155.8,65.2,157.4,60,157.6,55,156.1,50.8,153.1,47.4,149.1,44.9,144.6,43,139.7,41.6,134.7,40.6,129.5,40,124.3,39.6,119.1,39.5,113.9,39.6,108.7,39.9,103.5,37.3,100,32.6,97.6,28.1,95,23.6,92.3,19.3,89.3,15.2,86.1,11.3,82.7,7.7,78.9,4.5,74.7,1.9,70.2,0.3,65.2,0.1,60,1.6,55,4.6,50.8,8.6,47.4,13.1,44.9,18,43,23.1,41.6,28.2,40.6,33.4,39.9,38.6,39.6,43.8,39.5,49,39.6,54.3,39.9,57.8,37.3,60.2,32.7,62.7,28.1,65.5,23.6,68.4,19.3,71.6,15.2,75.1,11.3],
	star: [72,0,77.7,1.4,82.4,4.8,85.2,9.9,87.2,15.5,89.1,21.1,91.1,26.7,93.6,32,97.9,36,103.5,37.8,109.4,37.3,115.2,36.1,121,35,126.8,33.9,132.7,33.8,138,36.2,142,40.5,143.7,46.1,143.1,51.9,140.1,56.9,136.2,61.4,132.3,65.9,128.5,70.4,125.1,75.2,123.8,80.9,125.1,86.6,128.5,91.5,132.3,95.9,136.2,100.4,140.1,104.9,143.1,109.9,143.7,115.8,142,121.4,138,125.6,132.7,128,126.8,127.9,121,126.8,115.2,125.7,109.4,124.6,103.5,124.1,97.9,125.8,93.6,129.8,91.1,135.1,89.1,140.7,87.2,146.3,85.2,151.9,82.4,157,77.7,160.5,72,161.8,66.3,160.5,61.5,157,58.7,151.9,56.8,146.3,54.8,140.7,52.9,135.1,50.4,129.8,46.1,125.8,40.5,124.1,34.6,124.6,28.8,125.7,23,126.8,17.2,127.9,11.3,128,5.9,125.6,1.9,121.4,0.2,115.8,0.9,109.9,3.9,104.9,7.7,100.4,11.6,95.9,15.5,91.5,18.8,86.6,20.1,80.9,18.8,75.2,15.5,70.4,11.6,65.9,7.7,61.4,3.9,56.9,0.9,51.9,0.2,46.1,1.9,40.5,5.9,36.2,11.3,33.8,17.2,33.9,23,35,28.8,36.1,34.6,37.3,40.5,37.8,46.1,36,50.4,32,52.9,26.7,54.8,21.1,56.8,15.5,58.7,9.9,61.5,4.8,66.3,1.4],

};

// ---------------------------------------------------------------- polilinhas

type Poly = Point[];

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, steps: number): Poly {
	const out: Poly = [];
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		out.push([
			u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
			u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
		]);
	}
	return out;
}

/** Arco elíptico de a0 a a1 (rad, y para baixo). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Poly {
	const steps = Math.max(4, Math.ceil((Math.abs(a1 - a0) / TAU) * 64));
	const out: Poly = [];
	for (let i = 0; i <= steps; i++) {
		const a = a0 + ((a1 - a0) * i) / steps;
		out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
	}
	return out;
}

function polar(fn: (angle: number) => Point, steps = 256): Poly {
	return Array.from({ length: steps }, (_, i) => fn((i / steps) * TAU));
}

/** Polígono com cantos arredondados por curva quadrática (raio por canto). */
function rounded(corners: Point[], radius: number | number[]): Poly {
	const n = corners.length;
	const out: Poly = [];
	for (let i = 0; i < n; i++) {
		const prev = corners[(i - 1 + n) % n] as Point;
		const cur = corners[i] as Point;
		const next = corners[(i + 1) % n] as Point;
		const r = typeof radius === "number" ? radius : (radius[i % radius.length] as number);
		const toward = (from: Point, to: Point): Point => {
			const dx = from[0] - to[0];
			const dy = from[1] - to[1];
			const len = Math.hypot(dx, dy) || 1;
			return [dx / len, dy / len];
		};
		const a = toward(prev, cur);
		const b = toward(next, cur);
		const p0: Point = [cur[0] + a[0] * r, cur[1] + a[1] * r];
		const p2: Point = [cur[0] + b[0] * r, cur[1] + b[1] * r];
		for (let s = 0; s <= 12; s++) {
			const t = s / 12;
			const u = 1 - t;
			out.push([
				u * u * p0[0] + 2 * u * t * cur[0] + t * t * p2[0],
				u * u * p0[1] + 2 * u * t * cur[1] + t * t * p2[1],
			]);
		}
	}
	return out;
}

/** Raio máximo, por ângulo, de uma união de círculos (nuvem, trevo). */
function circleUnion(circles: [number, number, number][]): Poly {
	return polar((angle) => {
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		let best = 0;
		for (const [x, y, r] of circles) {
			const ox = x - CENTER;
			const oy = y - CENTER;
			const d = c * ox + s * oy;
			const disc = d * d - (ox * ox + oy * oy) + r * r;
			if (disc <= 0) continue;
			best = Math.max(best, d + Math.sqrt(disc));
		}
		return [CENTER + c * best, CENTER + s * best];
	}, 384);
}

const superellipse = (rx: number, ry: number, n: number): Poly =>
	polar((a) => {
		const c = Math.cos(a);
		const s = Math.sin(a);
		return [
			CENTER + Math.sign(c) * Math.abs(c) ** (2 / n) * rx,
			CENTER + Math.sign(s) * Math.abs(s) ** (2 / n) * ry,
		];
	});

function stadium(halfLong: number, halfShort: number, horizontal: boolean): Poly {
	const body = halfLong - halfShort;
	const pts: Poly = [];
	if (horizontal) {
		pts.push(...arc(CENTER + body, CENTER, halfShort, halfShort, -Math.PI / 2, Math.PI / 2));
		pts.push(...arc(CENTER - body, CENTER, halfShort, halfShort, Math.PI / 2, (Math.PI * 3) / 2));
	} else {
		pts.push(...arc(CENTER, CENTER + body, halfShort, halfShort, 0, Math.PI));
		pts.push(...arc(CENTER, CENTER - body, halfShort, halfShort, Math.PI, TAU));
	}
	return pts;
}

/** Corpo de topo elíptico e base reta com cantos suaves (cilindro, domo). */
function slab(halfW: number, halfH: number, topRadiusY: number, bottomCorner: number): Poly {
	const top = CENTER - halfH;
	const bottom = CENTER + halfH;
	const right = CENTER + halfW;
	const left = CENTER - halfW;
	return [
		...arc(CENTER, top + topRadiusY, halfW, topRadiusY, Math.PI, TAU),
		...bezier([right, bottom - bottomCorner], [right, bottom], [right, bottom], [right - bottomCorner, bottom], 8),
		...bezier([left + bottomCorner, bottom], [left, bottom], [left, bottom], [left, bottom - bottomCorner], 8),
	];
}

const GENERATORS: Record<Exclude<Shape, "heart" | "sparkle" | "star">, () => Poly> = {
	blob: () => polar((a) => [CENTER + Math.cos(a) * 110, CENTER + Math.sin(a) * 110]),
	pebble: () =>
		polar((a) => {
			const r = 108 * (1 + 0.075 * (Math.sin(a * 2 + 1.1) * 0.6 + Math.sin(a * 3 - 1.1) * 0.4));
			return [CENTER + Math.cos(a) * r, CENTER + Math.sin(a) * r * 0.98];
		}),
	bean: () =>
		polar((a) => {
			const bump = (center: number) => {
				const d = Math.abs((((a - center + Math.PI) % TAU) + TAU) % TAU - Math.PI);
				return Math.exp(-(d * d) / 0.4232);
			};
			const f = 1 - 0.34 * bump(Math.PI) + 0.34 * 0.34 * bump(0);
			return [CENTER + Math.cos(a) * 94 * f, CENTER + Math.sin(a) * 112 * f];
		}),
	egg: () =>
		polar((a) => {
			const bottomness = (1 - Math.sin(a)) / 2;
			return [CENTER + Math.cos(a) * 98 * (1 - 0.22 * bottomness * bottomness), CENTER + Math.sin(a) * 113];
		}),
	squircle: () => superellipse(107, 107, 3.2),
	tablet: () => stadium(114, 74, true),
	capsule: () => stadium(113, 72, false),
	cylinder: () => [
		...arc(CENTER, CENTER - 62, 94, 48, Math.PI, TAU),
		...arc(CENTER, CENTER + 62, 94, 48, 0, Math.PI),
	],
	hex: () =>
		rounded(
			Array.from({ length: 6 }, (_, i) => {
				const a = Math.PI / 6 + (i / 6) * TAU;
				return [CENTER + Math.cos(a) * 114, CENTER + Math.sin(a) * 114] as Point;
			}),
			20,
		),
	gem: () => superellipse(112, 113, 1.5),
	crystal: () =>
		rounded(
			[
				[CENTER, CENTER - 118],
				[CENTER + 70, CENTER - 44],
				[CENTER + 70, CENTER + 44],
				[CENTER, CENTER + 118],
				[CENTER - 70, CENTER + 44],
				[CENTER - 70, CENTER - 44],
			],
			16,
		),
	wedge: () =>
		rounded(
			Array.from({ length: 3 }, (_, i) => {
				const a = -Math.PI / 2 + (i / 3) * TAU;
				return [CENTER + Math.cos(a) * 130, CENTER + Math.sin(a) * 130] as Point;
			}),
			[80, 60, 60],
		),
	shield: () => {
		const w = 98;
		const top = CENTER - 108;
		const bottom = CENTER + 108;
		return [
			...bezier([CENTER - w, top + 30], [CENTER - w, top - 2], [CENTER - w * 0.5, top - 10], [CENTER, top - 10], 12),
			...bezier([CENTER, top - 10], [CENTER + w * 0.5, top - 10], [CENTER + w, top - 2], [CENTER + w, top + 30], 12),
			...bezier([CENTER + w, top + 30], [CENTER + w, CENTER + 45], [CENTER + w * 0.62, bottom], [CENTER, bottom], 16),
			...bezier([CENTER, bottom], [CENTER - w * 0.62, bottom], [CENTER - w, CENTER + 45], [CENTER - w, top + 30], 16),
		];
	},
	dome: () => slab(114, 82, 138, 26),
	arch: () => {
		const halfW = 76;
		const halfH = 113;
		const bottom = CENTER + halfH;
		const corner = 42;
		return [
			...arc(CENTER, CENTER - halfH + halfW, halfW, halfW, Math.PI, TAU),
			...bezier([CENTER + halfW, bottom - corner], [CENTER + halfW, bottom], [CENTER + halfW, bottom], [CENTER + halfW - corner, bottom], 10),
			...bezier([CENTER - halfW + corner, bottom], [CENTER - halfW, bottom], [CENTER - halfW, bottom], [CENTER - halfW, bottom - corner], 10),
		];
	},
	cloud: () =>
		circleUnion([
			[CENTER - 62, CENTER + 26, 56],
			[CENTER + 62, CENTER + 26, 54],
			[CENTER, CENTER + 34, 62],
			[CENTER - 24, CENTER - 30, 62],
			[CENTER + 38, CENTER - 26, 54],
		]),
	teardrop: () => {
		const r = 88;
		const apexY = CENTER - 114;
		const baseY = CENTER + 26;
		const s = clamp(r / (baseY - apexY), -1, 1);
		const k = Math.sqrt(1 - s * s);
		const right: Point = [CENTER + r * k, baseY - r * s];
		const left: Point = [CENTER - r * k, baseY - r * s];
		const a = Math.atan2(right[1] - baseY, right[0] - CENTER);
		return [
			...rounded([right, [CENTER, apexY], left], [0, 48, 0]),
			...arc(CENTER, baseY, r, r, Math.PI - a, a),
		];
	},
	leaf: () =>
		polar((a) => {
			const c = Math.cos(a);
			const s = Math.sin(a);
			return [CENTER + c * 88 * Math.max(1 - s * s, 0) ** 0.25, CENTER + s * 113];
		}),
	square: () =>
		rounded(
			[
				[CENTER - 107, CENTER - 107],
				[CENTER + 107, CENTER - 107],
				[CENTER + 107, CENTER + 107],
				[CENTER - 107, CENTER + 107],
			],
			28,
		),
	clover: () =>
		circleUnion([
			[CENTER - 38, CENTER - 38, 58],
			[CENTER + 38, CENTER - 38, 58],
			[CENTER + 38, CENTER + 38, 58],
			[CENTER - 38, CENTER + 38, 58],
		]),
	flower: () =>
		polar((a) => {
			const r = 92 * (1 + 0.16 * Math.cos(5 * a));
			return [CENTER + Math.cos(a) * r, CENTER + Math.sin(a) * r];
		}),
	house: () =>
		rounded(
			[
				[CENTER - 100, CENTER + 110],
				[CENTER + 100, CENTER + 110],
				[CENTER + 100, CENTER - 110 + 78],
				[CENTER, CENTER - 110],
				[CENTER - 100, CENTER - 110 + 78],
			],
			29,
		),
};

// ------------------------------------------------------- amostragem uniforme

function polylineOf(shape: Shape): Poly {
	if (shape === "heart" || shape === "sparkle" || shape === "star") {
		const flat = FREEFORM[shape];
		return Array.from(
			{ length: flat.length / 2 },
			(_, i) => [flat[i * 2] as number, flat[i * 2 + 1] as number] as Point,
		);
	}
	return GENERATORS[shape]();
}

function signedArea(poly: Poly): number {
	let sum = 0;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i] as Point;
		const b = poly[(i + 1) % poly.length] as Point;
		sum += a[0] * b[1] - b[0] * a[1];
	}
	return sum;
}

/** Centra no bbox e escala para ocupar ~FIT (limitado a 0,9–1,35×). */
function normalize(poly: Poly): Poly {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const [x, y] of poly) {
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	const k = clamp(FIT / Math.max(maxX - minX, maxY - minY), 0.9, 1.35);
	const mx = (minX + maxX) / 2;
	const my = (minY + maxY) / 2;
	return poly.map(([x, y]) => [CENTER + (x - mx) * k, CENTER + (y - my) * k] as Point);
}

/** Reamostra em N pontos por comprimento de arco, começando no topo (x = centro). */
export function resampleOutline(input: Poly, count = SHAPE_POINTS): Outline {
	let poly = normalize(input);
	if (signedArea(poly) < 0) poly = poly.slice().reverse();

	let best: { index: number; y: number } | null = null;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i] as Point;
		const b = poly[(i + 1) % poly.length] as Point;
		if ((a[0] - CENTER) * (b[0] - CENTER) > 0 || a[0] === b[0]) continue;
		const t = (CENTER - a[0]) / (b[0] - a[0]);
		const y = a[1] + (b[1] - a[1]) * t;
		if (y < CENTER && (best === null || y < best.y)) best = { index: i, y };
	}
	const start: Point = [CENTER, best?.y ?? CENTER - FIT / 2];
	const from = best ? best.index + 1 : 0;
	const ring: Poly = [start, ...poly.slice(from), ...poly.slice(0, from), start];

	const lengths = [0];
	for (let i = 1; i < ring.length; i++) {
		const a = ring[i - 1] as Point;
		const b = ring[i] as Point;
		lengths.push((lengths[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
	}
	const total = lengths[lengths.length - 1] as number;
	const out: number[] = [];
	let seg = 1;
	for (let i = 0; i < count; i++) {
		const target = (i / count) * total;
		while (seg < ring.length - 1 && (lengths[seg] as number) < target) seg++;
		const a = ring[seg - 1] as Point;
		const b = ring[seg] as Point;
		const span = (lengths[seg] as number) - (lengths[seg - 1] as number) || 1;
		const t = (target - (lengths[seg - 1] as number)) / span;
		out.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
	}
	return out;
}

const cache = new Map<Shape, Outline>();

/** Contorno da forma (memoizado): SHAPE_POINTS pontos, ponto 0 no topo. */
export function shapeOutline(shape: Shape): Outline {
	let outline = cache.get(shape);
	if (!outline) {
		outline = resampleOutline(polylineOf(shape));
		cache.set(shape, outline);
	}
	return outline;
}
