// Projeção dos sólidos (revolução, extrusão, almofada) em paths. Tudo em px do
// viewBox com y para cima e origem no centro; a conversão para a tela
// (CENTER + fit·x, CENTER − fit·y) é a última etapa. Funções puras.
import { applyMat, type Mat3 } from "../geometry/math.js";
import {
	convexHull,
	profileRadius,
	profileSlope,
	type Profile,
	type Ring,
	type WorldOutline,
} from "../geometry/solid.js";
import { BODY_RADIUS_PX, CENTER } from "../geometry/shapes.js";

/** Área mínima (px²) para uma face contar como visível (descarta as de perfil). */
const MIN_FACE_AREA = 1e-3;

/** Sólidos: 1 casa decimal (0,1 unidade do viewBox) basta e encurta o path pela metade. */
const num = (value: number) => Math.round(value * 10) / 10;

/** Pontos [x, y, …] em coordenadas de mundo → um subcaminho fechado na tela. */
export function loop(points: ArrayLike<number>, fit: number): string {
	let d = "";
	for (let i = 0; i < points.length; i += 2) {
		d += `${i === 0 ? "M" : "L"}${num(CENTER + fit * (points[i] as number))} ${num(CENTER - fit * (points[i + 1] as number))}`;
	}
	return `${d}Z`;
}

function signedArea(points: ArrayLike<number>): number {
	let sum = 0;
	const n = points.length / 2;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		sum += (points[i * 2] as number) * (points[j * 2 + 1] as number) - (points[j * 2] as number) * (points[i * 2 + 1] as number);
	}
	return sum / 2;
}

// ------------------------------------------------------------------ revolução

/** Silhueta de um sólido de revolução: casco convexo da superfície projetada. */
export function revolveHull(samples: Float64Array, m: Mat3): number[] {
	const projected = new Float64Array((samples.length / 3) * 2);
	for (let i = 0, k = 0; i < samples.length; i += 3) {
		projected[k++] = m[0] * (samples[i] as number) + m[1] * (samples[i + 1] as number) + m[2] * (samples[i + 2] as number);
		projected[k++] = m[3] * (samples[i] as number) + m[4] * (samples[i + 1] as number) + m[5] * (samples[i + 2] as number);
	}
	return convexHull(projected);
}

export function revolvePath(samples: Float64Array, m: Mat3, fit: number): string {
	return loop(revolveHull(samples, m), fit);
}

// --------------------------------------------------------------------- anéis

/**
 * Silhueta de um sólido em anéis (extrusão chanfrada, almofada): as faces
 * laterais e as tampas voltadas para a câmera, todas com a mesma orientação,
 * somam-se (regra não-zero) na união que é a silhueta. Faces de trás são
 * descartadas; faces laterais contíguas viram um polígono só (menos subcaminhos).
 */
export function ringsPath(world: WorldOutline, rings: readonly Ring[], m: Mat3, fit: number): string {
	const n = world.count;
	// R · (x − cx, y − cy, 0): contribuição do contorno; R · (cx, cy, 0) e R · ẑ à parte.
	const dx = new Float64Array(n);
	const dy = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const x = (world.pts[i * 2] as number) - world.cx;
		const y = (world.pts[i * 2 + 1] as number) - world.cy;
		dx[i] = m[0] * x + m[1] * y;
		dy[i] = m[3] * x + m[4] * y;
	}
	const bx = m[0] * world.cx + m[1] * world.cy;
	const by = m[3] * world.cx + m[4] * world.cy;

	const ringPoints = rings.map((ring) => {
		const out = new Float64Array(n * 2);
		const ox = bx + ring.z * m[2];
		const oy = by + ring.z * m[5];
		for (let i = 0; i < n; i++) {
			out[i * 2] = ox + ring.scale * (dx[i] as number);
			out[i * 2 + 1] = oy + ring.scale * (dy[i] as number);
		}
		return out;
	});

	let d = "";
	// Tampas: fundo (ordem invertida) e frente.
	const first = ringPoints[0] as Float64Array;
	const last = ringPoints[ringPoints.length - 1] as Float64Array;
	const reversed = new Float64Array(first.length);
	for (let i = 0; i < n; i++) {
		reversed[i * 2] = first[(n - 1 - i) * 2] as number;
		reversed[i * 2 + 1] = first[(n - 1 - i) * 2 + 1] as number;
	}
	if (signedArea(reversed) > MIN_FACE_AREA) d += loop(reversed, fit);
	if (signedArea(last) > MIN_FACE_AREA) d += loop(last, fit);

	// Faixas entre anéis consecutivos.
	const visible = new Uint8Array(n);
	for (let k = 0; k + 1 < ringPoints.length; k++) {
		const lo = ringPoints[k] as Float64Array;
		const hi = ringPoints[k + 1] as Float64Array;
		let count = 0;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const area =
				((lo[i * 2] as number) * (lo[j * 2 + 1] as number) - (lo[j * 2] as number) * (lo[i * 2 + 1] as number) +
					((lo[j * 2] as number) * (hi[j * 2 + 1] as number) - (hi[j * 2] as number) * (lo[j * 2 + 1] as number)) +
					((hi[j * 2] as number) * (hi[i * 2 + 1] as number) - (hi[i * 2] as number) * (hi[j * 2 + 1] as number)) +
					((hi[i * 2] as number) * (lo[i * 2 + 1] as number) - (lo[i * 2] as number) * (hi[i * 2 + 1] as number))) /
				2;
			visible[i] = area > MIN_FACE_AREA ? 1 : 0;
			count += visible[i] as number;
		}
		if (count === 0) continue;
		if (count === n) {
			// Anel inteiro visível: borda de fora e de dentro (buraco pela orientação oposta).
			d += loop(lo, fit);
			const back = new Float64Array(hi.length);
			for (let i = 0; i < n; i++) {
				back[i * 2] = hi[(n - 1 - i) * 2] as number;
				back[i * 2 + 1] = hi[(n - 1 - i) * 2 + 1] as number;
			}
			d += loop(back, fit);
			continue;
		}
		// Começa em uma face visível cuja anterior não é visível e junta as contíguas.
		let start = 0;
		while (!(visible[start] && !visible[(start + n - 1) % n])) start++;
		let i = start;
		let remaining = count;
		while (remaining > 0) {
			if (!visible[i % n]) {
				i++;
				continue;
			}
			const from = i % n;
			let len = 0;
			while (visible[(from + len) % n]) len++;
			const poly: number[] = [];
			for (let t = 0; t <= len; t++) {
				const idx = (from + t) % n;
				poly.push(lo[idx * 2] as number, lo[idx * 2 + 1] as number);
			}
			for (let t = len; t >= 0; t--) {
				const idx = (from + t) % n;
				poly.push(hi[idx * 2] as number, hi[idx * 2 + 1] as number);
			}
			d += loop(poly, fit);
			remaining -= len;
			i = from + len;
		}
	}
	return d;
}

// ------------------------------------------------------------------- olhos

/** Olho em face reta (extrusão): plano z = faceZ; some quando a face vira de costas. */
export function frontEyePath(local: ArrayLike<number>, faceZ: number, m: Mat3, fit: number): string {
	if (m[8] <= 0.03) return "";
	const out: number[] = [];
	for (let i = 0; i < local.length; i += 2) {
		const p = applyMat(m, local[i] as number, local[i + 1] as number, faceZ);
		out.push(p[0], p[1]);
	}
	return loop(out, fit);
}

/**
 * Olho enrolado num sólido de revolução (eixo y): o ponto (x, y) da face vira
 * (r·sen F, y, r·cos F), F = x / r(y). Pontos cuja normal fica de costas são
 * descartados; com menos de 3 pontos o olho some.
 */
export function wrapEyePath(local: ArrayLike<number>, profile: Profile, m: Mat3, fit: number): string {
	const vertical = profile.axis === "y";
	const minRadius = 0.12 * BODY_RADIUS_PX;
	const out: number[] = [];
	for (let i = 0; i < local.length; i += 2) {
		const x = local[i] as number;
		const y = local[i + 1] as number;
		const along = vertical ? y : x;
		const across = vertical ? x : y;
		const pos = Math.max(profile.lo, Math.min(profile.hi, along));
		const r = Math.max(0.02 * BODY_RADIUS_PX, profileRadius(profile, pos));
		const angle = Math.max(-2.6, Math.min(2.6, across / Math.max(minRadius, r)));
		const slope = -profileSlope(profile, pos);
		const s = Math.sin(angle);
		const c = Math.cos(angle);
		// normal da superfície em (r·sen F, pos, r·cos F): (sen F, −dr/dpos, cos F)
		const normal = vertical ? applyMat(m, s, slope, c) : applyMat(m, slope, s, c);
		if (normal[2] < 0.05) continue;
		const p = vertical ? applyMat(m, r * s, pos, r * c) : applyMat(m, pos, r * s, r * c);
		out.push(p[0], p[1]);
	}
	return out.length >= 6 ? loop(out, fit) : "";
}

/**
 * Olho numa forma de revolução com a transição contínua para o sólido: cada
 * ponto é a mistura (peso `t`) entre a posição plana (só o roll, face de
 * frente: o olho fica alinhado ao contorno 2D) e a projetada no sólido. Com
 * `t` = 1 é o `wrapEyePath` (descarta o que ficou de costas).
 */
export function blendedWrapEyePath(
	local: ArrayLike<number>,
	profile: Profile,
	m: Mat3,
	flat: Mat3,
	fit: number,
	t: number,
): string {
	if (t >= 1) return wrapEyePath(local, profile, m, fit);
	const vertical = profile.axis === "y";
	const minRadius = 0.12 * BODY_RADIUS_PX;
	const out: number[] = [];
	for (let i = 0; i < local.length; i += 2) {
		const x = local[i] as number;
		const y = local[i + 1] as number;
		const along = vertical ? y : x;
		const across = vertical ? x : y;
		const pos = Math.max(profile.lo, Math.min(profile.hi, along));
		const r = Math.max(0.02 * BODY_RADIUS_PX, profileRadius(profile, pos));
		const angle = Math.max(-2.6, Math.min(2.6, across / Math.max(minRadius, r)));
		const s = Math.sin(angle);
		const c = Math.cos(angle);
		const w = vertical ? applyMat(m, r * s, pos, r * c) : applyMat(m, pos, r * s, r * c);
		const f = applyMat(flat, x, y, 0);
		out.push(f[0] + (w[0] - f[0]) * t, f[1] + (w[1] - f[1]) * t);
	}
	return loop(out, fit);
}

/** Altura da almofada em (x, y) e função para a normal; ver `loftSurface`. */
export type Surface = (x: number, y: number) => number;

/**
 * Olho numa almofada (nuvem, coração): tangente à superfície no centro do
 * olho; some quando a normal gira de costas (limiar 0,12 da referência).
 */
export function loftEyePath(local: ArrayLike<number>, surface: Surface, m: Mat3, fit: number): string {
	let cx = 0;
	let cy = 0;
	const n = local.length / 2;
	for (let i = 0; i < local.length; i += 2) {
		cx += local[i] as number;
		cy += local[i + 1] as number;
	}
	cx /= n;
	cy /= n;
	const h = 0.004 * BODY_RADIUS_PX;
	const fx = (surface(cx + h, cy) - surface(cx - h, cy)) / (2 * h);
	const fy = (surface(cx, cy + h) - surface(cx, cy - h)) / (2 * h);
	const len = Math.hypot(fx, fy, 1);
	const normal = applyMat(m, -fx / len, -fy / len, 1 / len);
	if (normal[2] < 0.12) return "";
	const z0 = surface(cx, cy);
	const out: number[] = [];
	for (let i = 0; i < local.length; i += 2) {
		const x = local[i] as number;
		const y = local[i + 1] as number;
		const p = applyMat(m, x, y, z0 + (x - cx) * fx + (y - cy) * fy);
		out.push(p[0], p[1]);
	}
	return loop(out, fit);
}
