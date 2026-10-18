// Clipes de animação: tabelas de keyframes do app de referência (clip-data.ts).
// Cada trilha tem pontos [t, valor, ease cubic-bezier]; entre dois pontos vale
// o ease do primeiro. Funções puras: amostrar uma trilha, montar a pose de um
// clipe num instante e comparar poses.
import { CLIP_DATA } from "./clip-data.js";

export type Ease = readonly [number, number, number, number];
export type Keyframe = readonly [t: number, value: readonly number[], ease: Ease];

export type RawClip = {
	duration: number;
	/** -1 = o squash ancora na base do corpo (pulinhos), 0 = no centro. */
	anchor: number;
	/** Instante da pose inicial do clipe (início da "área de trabalho"). */
	rest: number;
	/** [pitch, yaw, roll] em graus. */
	rot: readonly Keyframe[];
	/** Em raios do corpo, y para cima. */
	pos: readonly Keyframe[];
	/** Zoom (0,6 = padrão). */
	scale: readonly Keyframe[];
	squash: readonly Keyframe[];
	/** [t, nome da expressão | "blink"]. */
	expr: readonly (readonly [number, string])[];
};

export type Pose = {
	rot: [number, number, number];
	pos: [number, number];
	squash: [number, number];
	zoom: number;
};

/** Zoom padrão do app de referência. */
export const DEFAULT_ZOOM = 0.6;
/** Duração (s) da ponte entre dois clipes. */
export const BRIDGE_S = 0.35;
/** Ease da ponte. */
export const BRIDGE_EASE: Ease = [0.4, 0, 0.2, 1];
/** Ease padrão (ease-in-out). */
export const DEFAULT_EASE: Ease = [0.42, 0, 0.58, 1];

export function restPose(): Pose {
	return { rot: [0, 0, 0], pos: [0, 0], squash: [1, 1], zoom: DEFAULT_ZOOM };
}

const bez = (u: number, a: number, b: number) => {
	const r = 1 - u;
	return 3 * r * r * u * a + 3 * r * u * u * b + u * u * u;
};
const bezDerivative = (u: number, a: number, b: number) => {
	const r = 1 - u;
	return 3 * r * r * a + 6 * r * u * (b - a) + 3 * u * u * (1 - b);
};

/** cubic-bezier(x1, y1, x2, y2): para o progresso x devolve y (Newton, como no app de referência). */
export function easeAt(x: number, ease: Ease): number {
	const [x1, y1, x2, y2] = ease;
	let u = x;
	for (let i = 0; i < 8; i++) {
		const err = bez(u, x1, x2) - x;
		const slope = bezDerivative(u, x1, x2);
		if (Math.abs(err) < 1e-6 || Math.abs(slope) < 1e-6) break;
		u = Math.min(1, Math.max(0, u - err / slope));
	}
	return bez(u, y1, y2);
}

/** Valor da trilha em `t` (nulo se a trilha é vazia). Antes/depois dos extremos vale o extremo. */
export function sampleTrack(track: readonly Keyframe[], t: number): readonly number[] | null {
	const first = track[0];
	if (!first) return null;
	if (t <= first[0]) return first[1];
	const last = track[track.length - 1] as Keyframe;
	if (t >= last[0]) return last[1];
	let i = 0;
	while (i < track.length - 2 && (track[i + 1] as Keyframe)[0] <= t) i++;
	const a = track[i] as Keyframe;
	const b = track[i + 1] as Keyframe;
	const k = easeAt((t - a[0]) / Math.max(b[0] - a[0], 1e-9), a[2]);
	return a[1].map((v, n) => v + ((b[1][n] as number) - v) * k);
}

/** Pose do clipe em `t`; trilhas ausentes valem o padrão. */
export function poseAt(clip: RawClip, t: number): Pose {
	const rot = sampleTrack(clip.rot, t);
	const pos = sampleTrack(clip.pos, t);
	const squash = sampleTrack(clip.squash, t);
	const zoom = sampleTrack(clip.scale, t);
	return {
		rot: rot ? [rot[0] as number, rot[1] as number, rot[2] as number] : [0, 0, 0],
		pos: pos ? [pos[0] as number, pos[1] as number] : [0, 0],
		squash: squash ? [squash[0] as number, squash[1] as number] : [1, 1],
		zoom: zoom ? (zoom[0] as number) : DEFAULT_ZOOM,
	};
}

/** Pose inicial do clipe (instante `rest`). */
export function startPose(clip: RawClip): Pose {
	return poseAt(clip, clip.rest);
}

/** Leva `angle` para o equivalente (± múltiplos de 360°) mais próximo de `near`. */
export function unwrapAngle(angle: number, near: number): number {
	return angle + 360 * Math.round((near - angle) / 360);
}

const angleGap = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/** Poses tão parecidas que dispensam a ponte (corta direto). */
export function posesClose(a: Pose, b: Pose): boolean {
	return (
		angleGap(a.rot[0], b.rot[0]) < 4 &&
		angleGap(a.rot[1], b.rot[1]) < 4 &&
		angleGap(a.rot[2], b.rot[2]) < 4 &&
		Math.abs(a.pos[0] - b.pos[0]) < 0.015 &&
		Math.abs(a.pos[1] - b.pos[1]) < 0.015 &&
		Math.abs(a.squash[0] - b.squash[0]) < 0.02 &&
		Math.abs(a.squash[1] - b.squash[1]) < 0.02 &&
		Math.abs(a.zoom - b.zoom) < 0.02
	);
}

/** Mistura de duas poses (rotação pelo caminho mais curto). */
export function lerpPose(a: Pose, b: Pose, k: number): Pose {
	const l = (x: number, y: number) => x + (y - x) * k;
	return {
		rot: [
			l(a.rot[0], unwrapAngle(b.rot[0], a.rot[0])),
			l(a.rot[1], unwrapAngle(b.rot[1], a.rot[1])),
			l(a.rot[2], unwrapAngle(b.rot[2], a.rot[2])),
		],
		pos: [l(a.pos[0], b.pos[0]), l(a.pos[1], b.pos[1])],
		squash: [l(a.squash[0], b.squash[0]), l(a.squash[1], b.squash[1])],
		zoom: l(a.zoom, b.zoom),
	};
}

export const CLIP_NAMES = Object.keys(CLIP_DATA);

export function getClip(name: string): RawClip {
	const clip = CLIP_DATA[name];
	if (!clip) throw new Error(`Clipe desconhecido: ${name}`);
	return clip;
}
