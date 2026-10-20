// Construtores de path (strings) do corpo e dos olhos, sem orientação 3D.
import { round2 } from "../geometry/math.js";
import type { EyeFrame } from "../model/character.js";

/** Pontos por ponta arredondada (meia-volta) e por lado reto do olho. */
const CAP_POINTS = 12;
const SIDE_POINTS = 10;

/** Corpo: `M x y L x y … Z`, 2 casas decimais. */
export function bodyPath(body: readonly number[]): string {
	let d = "";
	for (let i = 0; i < body.length; i += 2) {
		d += `${i === 0 ? "M" : "L"}${round2(body[i] as number)} ${round2(body[i + 1] as number)}`;
	}
	return `${d}Z`;
}

/**
 * Contorno do olho: cápsula (ou elipse achatada, se mais larga que comprida)
 * dobrada por uma parábola de flecha `bend`, girada por `rot` e espelhada no
 * olho direito. Devolve [x0, y0, …] em px do viewBox (y para baixo).
 */
export function eyePoints(eye: EyeFrame): number[] {
	const half = eye.length / 2;
	const radiusAlong = Math.min(eye.width / 2, half);
	const radiusAcross = eye.width / 2;
	const spine = half - radiusAlong;
	const angle = (eye.rot * Math.PI) / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	// Contorno local (sem dobra): ponta direita, lado de cima, ponta esquerda,
	// lado de baixo. Os lados retos também recebem pontos; sem eles a dobra
	// só aparece nas pontas e o "^" vira uma barra reta de pontas caídas.
	const local: number[] = [];
	const cap = (center: number, from: number) => {
		for (let i = 0; i < CAP_POINTS; i++) {
			const t = from + (i / CAP_POINTS) * Math.PI;
			local.push(center + radiusAlong * Math.cos(t), radiusAcross * Math.sin(t));
		}
	};
	const straight = (fromX: number, y: number) => {
		if (spine <= 0) return;
		for (let i = 0; i < SIDE_POINTS; i++) {
			local.push(fromX - Math.sign(fromX) * (i / SIDE_POINTS) * 2 * spine, y);
		}
	};
	cap(spine, -Math.PI / 2);
	straight(spine, radiusAcross);
	cap(-spine, Math.PI / 2);
	straight(-spine, -radiusAcross);
	const out: number[] = [];
	for (let i = 0; i < local.length; i += 2) {
		const lx = local[i] as number;
		const ly =
			(local[i + 1] as number) +
			eye.bend * (1 - (lx / half) * (lx / half));
		const rx = lx * cos - ly * sin;
		const ry = lx * sin + ly * cos;
		out.push(eye.cx + (eye.mirror ? -rx : rx), eye.cy - ry);
	}
	return out;
}

/** Olho como path fechado (sem orientação 3D). */
export function eyePath(eye: EyeFrame): string {
	const pts = eyePoints(eye);
	let d = "";
	for (let i = 0; i < pts.length; i += 2) {
		d += `${i === 0 ? "M" : "L"}${round2(pts[i] as number)} ${round2(pts[i + 1] as number)}`;
	}
	return `${d}Z`;
}

/** Os dois olhos num único `d` (dois subcaminhos): uma escrita por quadro. */
export function eyesPath(eyes: readonly EyeFrame[]): string {
	let d = "";
	for (const eye of eyes) d += eyePath(eye);
	return d;
}
