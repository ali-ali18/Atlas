// Morph: mistura ponto a ponto de contornos com o mesmo N (ver shapes.ts).
import type { Outline } from "./shapes.js";

export type MorphInput = { outline: Outline; weight: number };

/** Mistura contornos com pesos (normalizados para somar 1). */
export function mixOutlines(inputs: readonly MorphInput[], out?: number[]): number[] {
	const first = inputs[0];
	if (!first) throw new Error("mixOutlines precisa de ao menos um contorno");
	const length = first.outline.length;
	const result = out ?? new Array<number>(length).fill(0);
	let total = 0;
	for (const input of inputs) total += Math.max(0, input.weight);
	if (total <= 0) {
		for (let i = 0; i < length; i++) result[i] = first.outline[i] as number;
		return result;
	}
	for (let i = 0; i < length; i++) {
		let sum = 0;
		for (const input of inputs) {
			const w = Math.max(0, input.weight);
			if (w > 0) sum += (input.outline[i] as number) * w;
		}
		result[i] = sum / total;
	}
	return result;
}

/** Interpola do contorno `from` ao `to` (t em 0..1). */
export function lerpOutline(from: Outline, to: Outline, t: number, out?: number[]): number[] {
	return mixOutlines(
		[
			{ outline: from, weight: 1 - t },
			{ outline: to, weight: t },
		],
		out,
	);
}
