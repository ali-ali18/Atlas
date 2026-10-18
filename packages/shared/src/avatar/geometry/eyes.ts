// Ajuste dos olhos por forma. Unidades de rosto: 1,0 = FACE_UNIT unidades do
// SVG (viewBox 250). `gap` é a distância entre os centros dos dois olhos e
// `shiftY` sobe (positivo) ou desce o par em relação ao centro do corpo.
// Os valores vêm do ajuste visual do app de referência, forma por forma.
import type { Shape } from "./shapes.js";

export const FACE_UNIT = 114.27;

export type EyeFit = {
	width: number;
	height: number;
	gap: number;
	shiftY: number;
};

/** Base (a do hexágono): as expressões são definidas nestas dimensões. */
export const BASE_EYE = { width: 0.26, height: 0.57, gap: 0.64 } as const;

export const EYE_FIT: Record<Shape, EyeFit> = {
	blob: { width: 0.26, height: 0.57, gap: 0.64, shiftY: 0.08 },
	cloud: { width: 0.21294, height: 0.46683, gap: 0.470016, shiftY: 0.07 },
	square: { width: 0.255326, height: 0.559753, gap: 0.529408, shiftY: 0.12 },
	sparkle: { width: 0.18382, height: 0.40299, gap: 0.41216, shiftY: 0 },
	clover: { width: 0.23296, height: 0.51072, gap: 0.559104, shiftY: -0.02 },
	heart: { width: 0.186576, height: 0.409032, gap: 0.446208, shiftY: 0.052 },
	flower: { width: 0.19292, height: 0.42294, gap: 0.382976, shiftY: 0.12 },
	teardrop: { width: 0.207792, height: 0.455544, gap: 0.452608, shiftY: 0.18 },
	tablet: { width: 0.2132, height: 0.4674, gap: 0.587776, shiftY: 0.02 },
	wedge: { width: 0.2132, height: 0.4674, gap: 0.467712, shiftY: 0.18 },
	house: { width: 0.229512, height: 0.503162, gap: 0.512512, shiftY: 0.185 },
	star: { width: 0.184782, height: 0.44966, gap: 0.419133, shiftY: 0.12 },
	pebble: { width: 0.2392, height: 0.5244, gap: 0.546304, shiftY: 0.12 },
	bean: { width: 0.2028, height: 0.4446, gap: 0.4608, shiftY: 0.12 },
	egg: { width: 0.2392, height: 0.5244, gap: 0.433664, shiftY: 0.113 },
	squircle: { width: 0.2392, height: 0.5244, gap: 0.5632, shiftY: 0.12 },
	capsule: { width: 0.2106, height: 0.4617, gap: 0.360448, shiftY: 0.12 },
	cylinder: { width: 0.2392, height: 0.5244, gap: 0.47872, shiftY: 0.12 },
	hex: { width: 0.26, height: 0.57, gap: 0.64, shiftY: 0.12 },
	gem: { width: 0.2392, height: 0.5244, gap: 0.501248, shiftY: 0.12 },
	crystal: { width: 0.1612, height: 0.3534, gap: 0.3712, shiftY: 0.12 },
	shield: { width: 0.267904, height: 0.587328, gap: 0.444928, shiftY: 0.12 },
	dome: { width: 0.2132, height: 0.4674, gap: 0.47872, shiftY: 0.106 },
	arch: { width: 0.1924, height: 0.4218, gap: 0.448, shiftY: 0.16 },
	leaf: { width: 0.1872, height: 0.4104, gap: 0.448, shiftY: 0.04 },
};

/** Escalas de uma forma em relação à base (largura, altura, distância). */
export function eyeScales(shape: Shape): { w: number; h: number; gap: number } {
	const fit = EYE_FIT[shape];
	return {
		w: fit.width / BASE_EYE.width,
		h: fit.height / BASE_EYE.height,
		gap: fit.gap / BASE_EYE.gap,
	};
}
