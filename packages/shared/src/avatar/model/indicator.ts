// Morph de indicador: o corpo encolhe num núcleo e vira o próprio indicador
// (radar, órbita, anel de progresso, reticências), em vez de um spinner à
// parte. Valores e curvas do app de referência. Puro: o tempo anda por
// `advance`.
//
// Coordenadas das partes: px do viewBox (centro em CENTER), prontas para
// desenhar dentro do mesmo grupo do corpo (acompanham zoom e deslocamento).
import { clamp } from "../geometry/math.js";
import { CENTER, VIEW_FIT } from "../geometry/shapes.js";
import type { MorphName } from "./states.js";

/** Raio de referência (px da caixa de 228,54 do app original). */
const REF_B = 114.2705;
/** Da caixa de referência para o viewBox. */
const K = VIEW_FIT;

export type IndicatorKind = "dots" | "orbit" | "radar" | "progress";

export type Part =
	| { type: "disc"; cx: number; cy: number; r: number; opacity: number }
	| {
			type: "ring";
			cx: number;
			cy: number;
			r: number;
			width: number;
			opacity: number;
			/** Arco de progresso: fração da volta a partir de `startDeg`. */
			arc?: { fraction: number; startDeg: number };
	  };

export type IndicatorFrame = {
	kind: IndicatorKind;
	/** 0 = corpo normal, 1 = indicador completo. */
	amount: number;
	/** Rosto some quando o corpo já virou mais da metade. */
	faceVisible: boolean;
	/** Escala do corpo (núcleo do indicador) relativa ao corpo normal. */
	core: number;
	/** Quanto o contorno já virou círculo (0..1). */
	round: number;
	/** Zoom extra do conjunto (o indicador ocupa mais que o corpo). */
	zoom: number;
	/** Deslocamento vertical do núcleo (px), p.ex. o pulinho das reticências. */
	lift: number;
	parts: Part[];
};

/** Raio do núcleo (px da caixa de referência) e zoom por indicador. */
const CORE: Record<IndicatorKind, number> = { dots: 22, orbit: 19, radar: 19, progress: 19 };
const ZOOM: Record<IndicatorKind, number> = { dots: 1.5, orbit: 1.14, radar: 1.14, progress: 1.32 };

/** Morph da tabela de estados → indicador desenhado (os demais ainda não têm desenho). */
export function indicatorFor(morph: MorphName | null | undefined): IndicatorKind | null {
	switch (morph) {
		case "thinking":
			return "dots";
		case "orbit":
		case "radar":
		case "progress":
			return morph;
		case "spawning":
		case "dictating":
		case "sending":
		case "receiving":
		case "uploading":
		case "writing":
		case "alerting":
		case "bouncing":
		case "powering-down":
		case undefined:
		case null:
			return null;
	}
}

// ---------------------------------------------------------------------- curvas

/** Saída cúbica. */
const easeOut = (e: number) => 1 - (1 - e) ** 3;
/** Saída com pequeno overshoot. */
const easeBack = (e: number) => 1 + 2.70158 * (e - 1) ** 3 + 1.70158 * (e - 1) ** 2;
const easeInOut = (e: number) => (e < 0.5 ? 4 * e * e * e : 1 - (-2 * e + 2) ** 3 / 2);
const frac = (e: number) => ((e % 1) + 1) % 1;

/** Frequência (rad/s) da mola do morph: amortecimento crítico. */
const OMEGA = 14;
/** O anel de progresso enche em 2,5 s, some e recomeça 1,5 s depois. */
const PROGRESS_FILL_S = 2.5;
const PROGRESS_CYCLE_S = 4;

const px = (value: number) => CENTER + (value - REF_B) * K;
const len = (value: number) => value * K;

export class Indicator {
	private kind: IndicatorKind | null = null;
	/** Para qual indicador a mola está indo (null = voltando ao corpo). */
	private shown: IndicatorKind | null = null;
	private amount = 0;
	private velocity = 0;
	private time = 0;

	/** Muda o indicador (ou `null`, volta ao corpo). Reinicia o relógio dele. */
	set(kind: IndicatorKind | null): void {
		if (kind === this.kind) return;
		this.kind = kind;
		if (kind) {
			this.shown = kind;
			this.time = 0;
		}
	}

	get current(): IndicatorKind | null {
		return this.kind;
	}

	private targetAmount(): number {
		if (!this.kind) return 0;
		if (this.kind === "progress" && frac(this.time / PROGRESS_CYCLE_S) * PROGRESS_CYCLE_S >= PROGRESS_FILL_S) return 0;
		return 1;
	}

	/** Anda `dt` s (a mola é integrada em passos curtos: estável com quadro longo). */
	advance(dt: number): void {
		if (!(dt > 0)) return;
		if (this.kind) this.time += dt;
		const target = this.targetAmount();
		let left = dt;
		while (left > 1e-9) {
			const h = Math.min(left, 1 / 120);
			this.amount += this.velocity * h;
			this.velocity += (target - this.amount) * OMEGA * OMEGA * h - this.velocity * 2 * OMEGA * h;
			left -= h;
		}
		if (Math.abs(target - this.amount) < 0.001 && Math.abs(this.velocity) < 0.01) {
			this.amount = target;
			this.velocity = 0;
			if (target === 0 && !this.kind) this.shown = null;
		}
	}

	/** Em repouso: nada a animar (sem indicador e já de volta ao corpo). */
	get isSettled(): boolean {
		return !this.kind && this.amount === 0 && this.velocity === 0;
	}

	frame(): IndicatorFrame | null {
		const kind = this.shown;
		const s = clamp(this.amount, 0, 1);
		if (!kind || s <= 0.0005) return null;
		const t = this.time;
		const bounce = kind === "dots" ? dotsBounce(t) : null;
		const core = (CORE[kind] / REF_B) * (bounce ? bounce.pop : 1);
		return {
			kind,
			amount: s,
			faceVisible: s < 0.5,
			core: 1 - s + core * s,
			round: easeInOut(clamp(s / 0.62, 0, 1)),
			zoom: 1 + (ZOOM[kind] - 1) * s,
			lift: bounce ? -bounce.lift * s * K : 0,
			parts: partsOf(kind, s, t),
		};
	}
}

// ------------------------------------------------------------------- reticências

/** Pulinho das reticências: um pulso gaussiano que percorre os pontos a cada 1,4 s. */
function dotsBounce(t: number, index = 1): { lift: number; pop: number; tone: number } {
	const phase = frac((t * 1000) / 1400 + 0.119);
	const dist = Math.abs(phase - index / 3);
	const near = Math.min(dist, 1 - dist);
	const a = Math.exp(-(near * near) / (2 * 0.15 * 0.15));
	return { lift: a * 9, pop: 1 + (0.84 + 0.22 * a - 1), tone: 1 - 0.5 * (1 - a) };
}

function partsOf(kind: IndicatorKind, s: number, t: number): Part[] {
	switch (kind) {
		case "dots":
			return dotsParts(s, t);
		case "orbit":
			return orbitParts(s, t);
		case "radar":
			return radarParts(s, t);
		case "progress":
			return progressParts(s, t);
	}
}

function dotsParts(s: number, t: number): Part[] {
	const parts: Part[] = [];
	const sides = [REF_B - 62, REF_B + 62];
	for (let o = 0; o < 2; o++) {
		const i = clamp((s - o * 0.12) / (1 - o * 0.12), 0, 1);
		if (i <= 0.004) continue;
		const a = easeOut(i);
		const c = easeBack(i);
		const u = dotsBounce(t, o === 0 ? 0 : 2);
		parts.push({
			type: "disc",
			cx: px(REF_B + ((sides[o] as number) - REF_B) * c),
			cy: CENTER - len(u.lift * s),
			r: len(22 * a * u.pop * 1.02),
			opacity: a * u.tone,
		});
	}
	return parts;
}

function orbitParts(s: number, t: number): Part[] {
	const n = easeOut(s);
	const radius = 52 * easeBack(s);
	const base = t * 1000 * 0.0017;
	return Array.from({ length: 5 }, (_, i) => {
		const c = base + (i * Math.PI * 2) / 5;
		const u = Math.cos(c);
		const l = 0.5 + 0.5 * clamp(u, 0, 1);
		return {
			type: "disc" as const,
			cx: px(REF_B + radius * Math.sin(c)),
			cy: px(REF_B - radius * 0.42 * u),
			r: len(Math.max(12 * l * n, 0.3)),
			opacity: clamp((u + 0.4) / 0.6, 0.18, 1) * n,
		};
	});
}

function radarParts(s: number, t: number): Part[] {
	const n = easeOut(s);
	const core = CORE.radar;
	return Array.from({ length: 3 }, (_, i) => {
		const c = frac((t * 1000) / 1300 + i / 3);
		return {
			type: "ring" as const,
			cx: CENTER,
			cy: CENTER,
			r: len(core + (104 - core) * c),
			width: len(3.4 * (1 - c * 0.55)),
			opacity: n * (1 - c) * 0.9,
		};
	});
}

function progressParts(s: number, t: number): Part[] {
	const n = easeOut(s);
	const r = len(62 * easeBack(s));
	const shot = (frac(t / PROGRESS_CYCLE_S) * PROGRESS_CYCLE_S) / PROGRESS_FILL_S;
	const fill = clamp(shot / 0.85, 0, 1);
	const track: Part = { type: "ring", cx: CENTER, cy: CENTER, r, width: len(5), opacity: n * 0.16 };
	if (fill <= 0) return [track];
	return [track, { type: "ring", cx: CENTER, cy: CENTER, r, width: len(5), opacity: n, arc: { fraction: fill, startDeg: -90 } }];
}
