// Matemática básica do motor de avatar: pura, sem DOM, sem relógio.

export const TAU = Math.PI * 2;

export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

/** Suavização clássica (3t² − 2t³) para transições de duração fixa. */
export function smoothstep(t: number): number {
	const x = clamp(t, 0, 1);
	return x * x * (3 - 2 * x);
}

/** Arredonda para 2 casas (strings de path curtas e comparáveis). */
export function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

/**
 * Arredonda para 1 casa: coordenadas de `d`. No viewBox de 250 uma casa é ~0,04 px num avatar de 100 px,
 * invisível, e faz a respiração lenta repetir a string (o ticker então não escreve o `d` de novo).
 */
export function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/** FNV-1a de 32 bits. */
export function hash(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** mulberry32: gerador determinístico com semente de 32 bits. */
export function rng(seed: number): () => number {
	let t = seed >>> 0;
	return () => {
		t = (t + 0x6d2b79f5) | 0;
		let n = Math.imul(t ^ (t >>> 15), 1 | t);
		n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
		return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
	};
}

/** Sorteia no intervalo [min, max). */
export function between(random: () => number, min: number, max: number): number {
	return min + random() * (max - min);
}

/** Mola amortecida de 1 dimensão. `target` pode mudar a qualquer momento. */
export type Spring = { value: number; velocity: number; target: number };

export function spring(value = 0): Spring {
	return { value, velocity: 0, target: value };
}

const MAX_SUBSTEP_S = 1 / 120;

/**
 * Integra a mola (Euler semi-implícito, em subpassos para ficar estável com
 * quadros longos): pos += vel·dt; vel += (alvo − pos)·k·dt − vel·d·dt.
 */
export function stepSpring(s: Spring, dtS: number, k: number, d: number): void {
	let left = dtS;
	while (left > 1e-9) {
		const h = Math.min(left, MAX_SUBSTEP_S);
		s.value += s.velocity * h;
		s.velocity += (s.target - s.value) * k * h - s.velocity * d * h;
		left -= h;
	}
}

export function springSettled(s: Spring, epsilon = 0.002): boolean {
	return (
		Math.abs(s.target - s.value) < epsilon && Math.abs(s.velocity) < epsilon * 4
	);
}

/** Encosta a mola no alvo (para quando ela já está dentro do limiar). */
export function snapSpring(s: Spring): void {
	s.value = s.target;
	s.velocity = 0;
}

// ------------------------------------------------------------------ rotação 3D

export const DEG = Math.PI / 180;

/** Matriz 3×3 em linhas: [m00 m01 m02 m10 m11 m12 m20 m21 m22]. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export type Vec3 = readonly [number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Orientação do personagem: R = Rz(roll) · Rx(pitch) · Ry(yaw), em graus.
 * Convenção: +yaw leva a frente (0,0,1) para a direita (+x); +pitch a leva
 * para baixo; +roll gira no sentido anti-horário na tela. Y para cima, câmera
 * em +z olhando para −z (projeção ortográfica: descarta z).
 */
export function rotationMatrix(yawDeg: number, pitchDeg: number, rollDeg: number): Mat3 {
	const cy = Math.cos(yawDeg * DEG);
	const sy = Math.sin(yawDeg * DEG);
	const cp = Math.cos(pitchDeg * DEG);
	const sp = Math.sin(pitchDeg * DEG);
	const cr = Math.cos(rollDeg * DEG);
	const sr = Math.sin(rollDeg * DEG);
	// Rx · Ry
	const a00 = cy;
	const a01 = 0;
	const a02 = sy;
	const a10 = sp * sy;
	const a11 = cp;
	const a12 = -sp * cy;
	const a20 = -cp * sy;
	const a21 = sp;
	const a22 = cp * cy;
	// Rz · (Rx · Ry)
	return [
		cr * a00 - sr * a10,
		cr * a01 - sr * a11,
		cr * a02 - sr * a12,
		sr * a00 + cr * a10,
		sr * a01 + cr * a11,
		sr * a02 + cr * a12,
		a20,
		a21,
		a22,
	];
}

/** Aplica `m` a (x, y, z). */
export function applyMat(m: Mat3, x: number, y: number, z: number): Vec3 {
	return [
		m[0] * x + m[1] * y + m[2] * z,
		m[3] * x + m[4] * y + m[5] * z,
		m[6] * x + m[7] * y + m[8] * z,
	];
}

/** Só a componente z de `m · (x, y, z)` (visibilidade sem alocar o vetor). */
export function applyMatZ(m: Mat3, x: number, y: number, z: number): number {
	return m[6] * x + m[7] * y + m[8] * z;
}

/** `true` quando a orientação é (quase) só um giro no plano da tela. */
export function isPlanar(yawDeg: number, pitchDeg: number, eps = 1e-4): boolean {
	return Math.abs(yawDeg) < eps && Math.abs(pitchDeg) < eps;
}
