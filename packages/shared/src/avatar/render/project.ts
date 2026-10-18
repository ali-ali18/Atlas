// Projeção 3D → path 2D. O personagem tem orientação (yaw/pitch/roll): o corpo
// e os olhos são levados ao espaço 3D do sólido da forma (esfera, revolução,
// extrusão ou almofada), girados pela matriz e projetados de forma ortográfica
// (descarta z). Funções puras; nada de DOM.
import { loftSurface } from "../geometry/loft.js";
import {
	IDENTITY,
	applyMat,
	rotationMatrix,
	round2,
	type Mat3,
} from "../geometry/math.js";
import { BODY_RADIUS_PX, CENTER } from "../geometry/shapes.js";
import {
	SOLID_KIND,
	extrusionRings,
	loftRings,
	revolveProfile,
	revolveSamples,
	worldOutline,
	type Profile,
	type Ring,
	type SolidKind,
	type WorldOutline,
} from "../geometry/solid.js";
import { projectSpherePoints, sphereEyePoints } from "../geometry/surface.js";
import type { EyeFrame, Frame } from "../model/character.js";
import { bodyPath, eyePoints, eyesPath } from "./path.js";
import {
	frontEyePath,
	loftEyePath,
	blendedWrapEyePath,
	loop,
	revolveHull,
	ringsPath,
	type Surface,
} from "./project-solid.js";

/** Os sólidos usam metade dos pontos do contorno (48): menos faces por quadro. */
const SOLID_STRIDE = 2;

export type Projected = { body: string; eyes: string };

/** Geometria do sólido do quadro, calculada uma vez por contorno (não por quadro). */
export type Prepared = {
	kind: SolidKind;
	world: WorldOutline;
	rings?: Ring[];
	profile?: Profile;
	samples?: Float64Array;
	surface?: Surface;
	faceZ?: number;
};

export function prepare(frame: Frame): Prepared {
	const kind = SOLID_KIND[frame.shape];
	const world = worldOutline(frame.body, SOLID_STRIDE);
	switch (kind.type) {
		case "sphere":
			return { kind, world };
		case "revolve": {
			const profile = revolveProfile(world, kind.axis);
			return { kind, world, profile, samples: revolveSamples(profile) };
		}
		case "extrusion": {
			const rings = extrusionRings(kind, world.halfMin);
			return { kind, world, rings, faceZ: (rings[rings.length - 1] as Ring).z };
		}
		case "loft":
			return { kind, world, rings: loftRings(kind), surface: loftSurface(world, kind) };
	}
}

function isIdentity(m: Mat3, fit: number): boolean {
	return fit === 1 && m.every((value, i) => value === IDENTITY[i]);
}

function matrixOf(frame: Frame): Mat3 {
	const { yaw, pitch, roll } = frame.orientation;
	return rotationMatrix(yaw, pitch, roll);
}

/** Pontos [x0, y0, …] (px do viewBox, y para baixo) → path com a projeção `m` (corpo plano). */
function flatPath(points: ArrayLike<number>, m: Mat3, fit: number): string {
	let d = "";
	for (let i = 0; i < points.length; i += 2) {
		const [x, y] = applyMat(m, (points[i] as number) - CENTER, CENTER - (points[i + 1] as number), 0);
		d += `${i === 0 ? "M" : "L"}${round2(CENTER + fit * x)} ${round2(CENTER - fit * y)}`;
	}
	return `${d}Z`;
}

/** `true` quando a orientação é só um giro no plano da tela (a face fica de frente). */
function isFrontal(m: Mat3): boolean {
	return Math.abs(m[2]) < 1e-9 && Math.abs(m[5]) < 1e-9 && m[8] > 0.9999999;
}

/** Giro (graus) em que o corpo de revolução já é todo o sólido simétrico. */
export const REVOLVE_FULL_DEG = 35;
const POLAR_STEPS = 128;

/** Peso do sólido (0 = contorno 2D, 1 = sólido): sobe suave com o maior giro de yaw/pitch. */
export function revolveBlend(frame: Frame): number {
	const wrap = (deg: number) => Math.abs(((((deg + 180) % 360) + 360) % 360) - 180);
	const x = Math.min(1, Math.max(wrap(frame.orientation.yaw), wrap(frame.orientation.pitch)) / REVOLVE_FULL_DEG);
	return x * x * (3 - 2 * x);
}

/** Raio do polígono (pontos [x, y, …], contém a origem) em cada um dos POLAR_STEPS ângulos. */
function polarRadii(points: ArrayLike<number>): Float64Array {
	const n = points.length / 2;
	const out = new Float64Array(POLAR_STEPS);
	for (let k = 0; k < POLAR_STEPS; k++) {
		const dx = Math.cos((k / POLAR_STEPS) * Math.PI * 2);
		const dy = Math.sin((k / POLAR_STEPS) * Math.PI * 2);
		let best = 0;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const ax = points[i * 2] as number;
			const ay = points[i * 2 + 1] as number;
			const ex = (points[j * 2] as number) - ax;
			const ey = (points[j * 2 + 1] as number) - ay;
			const den = dx * ey - dy * ex;
			if (Math.abs(den) < 1e-12) continue;
			const r = (ax * ey - ay * ex) / den;
			const u = (ax * dy - ay * dx) / den;
			if (r > best && u >= -1e-9 && u <= 1 + 1e-9) best = r;
		}
		out[k] = best;
	}
	return out;
}

/** Silhueta de revolução entre o contorno 2D (com roll) e o casco do sólido: mistura dos raios polares. */
function blendedRevolvePath(frame: Frame, flat: Mat3, m: Mat3, samples: Float64Array, t: number): string {
	const contour: number[] = [];
	for (let i = 0; i < frame.body.length; i += 2) {
		const p = applyMat(flat, (frame.body[i] as number) - CENTER, CENTER - (frame.body[i + 1] as number), 0);
		contour.push(p[0], p[1]);
	}
	const a = polarRadii(contour);
	const b = polarRadii(revolveHull(samples, m));
	const pts: number[] = [];
	for (let k = 0; k < POLAR_STEPS; k++) {
		const r = (a[k] as number) + ((b[k] as number) - (a[k] as number)) * t;
		const angle = (k / POLAR_STEPS) * Math.PI * 2;
		pts.push(r * Math.cos(angle), r * Math.sin(angle));
	}
	return loop(pts, frame.fit);
}

/** Corpo do quadro, com a orientação aplicada. */
export function projectBody(
	frame: Frame,
	m: Mat3 = matrixOf(frame),
	prepared: Prepared = prepare(frame),
): string {
	if (prepared.kind.type === "sphere") {
		// A esfera não muda de silhueta com yaw/pitch: só o roll (no plano) a gira.
		const body = rotationMatrix(0, 0, frame.orientation.roll);
		return isIdentity(body, frame.fit) ? bodyPath(frame.body) : flatPath(frame.body, body, frame.fit);
	}
	// Revolução: de frente vale o contorno 2D (com seus calombos); ao girar, a
	// silhueta passa CONTINUAMENTE para a do sólido simétrico (ver `revolveBlend`).
	if (prepared.kind.type === "revolve") {
		const t = revolveBlend(frame);
		const flat = rotationMatrix(0, 0, frame.orientation.roll);
		if (t === 0) return isIdentity(flat, frame.fit) ? bodyPath(frame.body) : flatPath(frame.body, flat, frame.fit);
		return blendedRevolvePath(frame, flat, m, prepared.samples as Float64Array, t);
	}
	// De frente (só roll), a silhueta dos demais sólidos é o próprio contorno
	// (extrusão/almofada têm o contorno como anel maior): mesmo path do 2D.
	if (isFrontal(m)) {
		return isIdentity(m, frame.fit) ? bodyPath(frame.body) : flatPath(frame.body, m, frame.fit);
	}
	return ringsPath(prepared.world, prepared.rings as Ring[], m, frame.fit);
}

/** Polígono de pontos [x, y, …] em unidades de corpo (y para cima) → path. */
function unitPath(points: readonly number[], fit: number): string {
	const radius = BODY_RADIUS_PX * fit;
	let d = "";
	for (let i = 0; i < points.length; i += 2) {
		d += `${i === 0 ? "M" : "L"}${round2(CENTER + radius * (points[i] as number))} ${round2(CENTER - radius * (points[i + 1] as number))}`;
	}
	return `${d}Z`;
}

/** Olho na esfera: mapa exponencial em torno do centro do olho, depois gira e corta o que ficou atrás. */
function sphereEyePath(eye: EyeFrame, m: Mat3, fit: number): string {
	const pts = eyePoints(eye);
	const local: number[] = [];
	for (let i = 0; i < pts.length; i += 2) {
		local.push(((pts[i] as number) - eye.cx) / BODY_RADIUS_PX, (eye.cy - (pts[i + 1] as number)) / BODY_RADIUS_PX);
	}
	const onSphere = sphereEyePoints(
		local,
		(eye.cx - CENTER) / BODY_RADIUS_PX,
		(CENTER - eye.cy) / BODY_RADIUS_PX,
	);
	const visible = projectSpherePoints(onSphere, m);
	return visible ? unitPath(visible, fit) : "";
}

/** Pontos do olho no plano da face (px, origem no centro, y para cima). */
function faceEyePoints(eye: EyeFrame): number[] {
	const pts = eyePoints(eye);
	const out: number[] = [];
	for (let i = 0; i < pts.length; i += 2) out.push((pts[i] as number) - CENTER, CENTER - (pts[i + 1] as number));
	return out;
}

/** Olhos do quadro (um `d` com os dois), com a orientação aplicada. */
export function projectEyes(
	frame: Frame,
	m: Mat3 = matrixOf(frame),
	prepared: Prepared = prepare(frame),
): string {
	let d = "";
	// Com o corpo virando indicador o rosto some (mais da metade do caminho).
	if (frame.indicator && !frame.indicator.faceVisible) return "";
	switch (prepared.kind.type) {
		case "sphere":
			for (const eye of frame.eyes) d += sphereEyePath(eye, m, frame.fit);
			return d;
		case "extrusion":
			// Face reta de frente: olhos planos idênticos aos do 2D.
			if (isIdentity(m, frame.fit)) return eyesPath(frame.eyes);
			for (const eye of frame.eyes) {
				d += frontEyePath(faceEyePoints(eye), prepared.faceZ as number, m, frame.fit);
			}
			return d;
		case "revolve":
			for (const eye of frame.eyes) {
				d += blendedWrapEyePath(
					faceEyePoints(eye),
					prepared.profile as Profile,
					m,
					rotationMatrix(0, 0, frame.orientation.roll),
					frame.fit,
					revolveBlend(frame),
				);
			}
			return d;
		case "loft":
			for (const eye of frame.eyes) {
				d += loftEyePath(faceEyePoints(eye), prepared.surface as Surface, m, frame.fit);
			}
			return d;
	}
}

/** Corpo e olhos do quadro, já com a orientação aplicada. */
export function projectFrame(frame: Frame): Projected {
	const m = matrixOf(frame);
	const prepared = prepare(frame);
	return { body: projectBody(frame, m, prepared), eyes: projectEyes(frame, m, prepared) };
}

/**
 * Projetor com memória: o sólido só é refeito quando o contorno ou a forma
 * mudam, e o corpo só é reprojetado quando a orientação ou o enquadramento
 * mudam (avatar parado não refaz o path).
 */
export function createProjector(): (frame: Frame) => Projected {
	let solidKey = "";
	let prepared: Prepared | null = null;
	let bodyKey = "";
	let body = "";
	return (frame) => {
		const m = matrixOf(frame);
		const nextSolid = `${frame.bodyRev}|${frame.shape}`;
		if (nextSolid !== solidKey || !prepared) {
			solidKey = nextSolid;
			prepared = prepare(frame);
			bodyKey = "";
		}
		const { yaw, pitch, roll } = frame.orientation;
		const nextBody = `${yaw}|${pitch}|${roll}|${frame.fit}`;
		if (nextBody !== bodyKey) {
			bodyKey = nextBody;
			body = projectBody(frame, m, prepared);
		}
		return { body, eyes: projectEyes(frame, m, prepared) };
	};
}
