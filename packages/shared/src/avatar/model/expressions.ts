// Expressões: mudam SÓ os olhos. Cada olho é uma "cápsula dobrável":
//  - `length`: comprimento ponta a ponta (inclui as pontas arredondadas);
//  - `width`: espessura;
//  - `rot`: ângulo do eixo em graus, a partir da horizontal, anti-horário
//    (90 = em pé). O olho direito é o espelho do esquerdo;
//  - `bend`: flecha da curvatura (positivo = "^", negativo = "∪");
//  - `dx` (para fora) e `dy` (para cima): deslocamento em relação ao lugar
//    padrão do olho.
// Unidades de rosto (ver geometry/eyes.ts), na dimensão base de olho.
import { lerp } from "../geometry/math.js";

export type EyeParams = {
	length: number;
	width: number;
	rot: number;
	bend: number;
	dx: number;
	dy: number;
};

export type EyePair = readonly [EyeParams, EyeParams];

export const EXPRESSIONS = [
	"neutral",
	"happy",
	"surprised",
	"sad",
	"sleepy",
	"squinted",
	"calm",
	"inspecting",
	"confused",
	"angry",
] as const;

export type Expression = (typeof EXPRESSIONS)[number];

/** Apelidos aceitos por `normalizeExpression`. */
const ALIASES: Record<string, Expression> = {
	smile: "happy",
	sleep: "sleepy",
	idle: "neutral",
	thinking: "sad",
	strange: "inspecting",
	inspect: "inspecting",
	squint: "squinted",
};

export function normalizeExpression(name: string): Expression {
	const key = name.trim().toLowerCase();
	const alias = ALIASES[key] ?? key;
	return (EXPRESSIONS as readonly string[]).includes(alias)
		? (alias as Expression)
		: "neutral";
}

const eye = (p: Partial<EyeParams>): EyeParams => ({
	length: 0.57,
	width: 0.26,
	rot: 90,
	bend: 0,
	dx: 0,
	dy: 0,
	...p,
});

const both = (p: EyeParams): EyePair => [p, p];

export const EXPRESSION_EYES: Record<Expression, EyePair> = {
	// cápsulas verticais
	neutral: both(eye({})),
	// arcos "^ ^"
	happy: both(eye({ length: 0.5, width: 0.14, rot: 0, bend: 0.3, dy: -0.1 })),
	// maiores e mais redondos
	surprised: both(eye({ length: 0.86, width: 0.42, dy: 0.03 })),
	// pontas de fora caídas ("/ \"), levemente mais baixos
	sad: both(eye({ length: 0.5, rot: 62, dy: -0.05 })),
	// achatados: linhas curtas
	sleepy: both(eye({ length: 0.5, width: 0.17, rot: 0, bend: -0.06 })),
	// achatados com leve curva
	squinted: both(eye({ length: 0.52, width: 0.2, rot: 0, bend: 0.04, dy: 0.01 })),
	// semicerrados
	calm: both(eye({ length: 0.33, dy: -0.06 })),
	// um olho menor que o outro
	inspecting: [
		eye({ length: 0.54, width: 0.54, dy: 0.04 }),
		eye({ length: 0.27, width: 0.27, dy: 0.04 }),
	],
	// alturas diferentes
	confused: [
		eye({ length: 0.68, dy: 0.04 }),
		eye({ length: 0.36, dy: -0.05 }),
	],
	// pontas de fora para cima ("\ /"), mais estreitos: cara fechada
	angry: both(eye({ length: 0.5, width: 0.24, rot: 112, dy: -0.02 })),
};

export function lerpEye(a: EyeParams, b: EyeParams, t: number): EyeParams {
	return {
		length: lerp(a.length, b.length, t),
		width: lerp(a.width, b.width, t),
		rot: lerp(a.rot, b.rot, t),
		bend: lerp(a.bend, b.bend, t),
		dx: lerp(a.dx, b.dx, t),
		dy: lerp(a.dy, b.dy, t),
	};
}

export function lerpPair(a: EyePair, b: EyePair, t: number): EyePair {
	return [lerpEye(a[0], b[0], t), lerpEye(a[1], b[1], t)];
}

/** Estados do desenho antigo (bloub, em francês) → expressão do motor. */
const LEGACY_STATES: Record<string, Expression> = {
	neutre: "neutral",
	attentif: "neutral",
	curieux: "neutral",
	heureux: "happy",
	hilare: "happy",
	fier: "happy",
	excite: "surprised",
	surpris: "surprised",
	yeux_ecarquilles: "surprised",
	effraye: "surprised",
	mefiant: "squinted",
	timide: "sad",
	triste: "sad",
	blase: "calm",
	somnolent: "sleepy",
	confus: "confused",
	colere: "angry",
};

export function expressionForLegacyState(state: string | undefined): Expression {
	return (state && LEGACY_STATES[state]) || "neutral";
}
