import { describe, expect, it } from "vitest";

import { EYE_FIT, eyeScales } from "./eyes.js";
import { projectSpherePoints, sphereEyePoints } from "./surface.js";
import {
	IDENTITY,
	applyMat,
	between,
	clamp,
	hash,
	rng,
	rotationMatrix,
	spring,
	springSettled,
	stepSpring,
} from "./math.js";
import { lerpOutline, mixOutlines } from "./morph.js";
import {
	AVATAR_BOX,
	BODY_RADIUS_PX,
	CENTER,
	SHAPE_IDS,
	SHAPE_POINTS,
	VIEW_FIT,
	isShape,
	shapeFit,
	shapeOutline,
	shapeScale,
	worstPointRadius,
	worstPointScale,
} from "./shapes.js";

describe("math", () => {
	it("hash FNV-1a é estável e rng(seed) é determinístico", () => {
		expect(hash("agente-123")).toBe(hash("agente-123"));
		expect(hash("a")).not.toBe(hash("b"));
		expect(hash("")).toBe(2166136261);
		const a = rng(42);
		const b = rng(42);
		const seq = Array.from({ length: 5 }, () => a());
		expect(Array.from({ length: 5 }, () => b())).toEqual(seq);
		for (const value of seq) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
		expect(rng(43)()).not.toBe(seq[0]);
	});

	it("between sorteia dentro do intervalo e clamp limita", () => {
		const random = rng(7);
		for (let i = 0; i < 200; i++) {
			const v = between(random, 2, 6);
			expect(v).toBeGreaterThanOrEqual(2);
			expect(v).toBeLessThan(6);
		}
		expect(clamp(5, 0, 1)).toBe(1);
		expect(clamp(-5, 0, 1)).toBe(0);
	});

	it("mola converge ao alvo, sem explodir com quadro longo", () => {
		const s = spring(0);
		s.target = 1;
		for (let i = 0; i < 120; i++) stepSpring(s, 0.1, 150, 17);
		expect(springSettled(s)).toBe(true);
		expect(s.value).toBeCloseTo(1, 2);
	});
});

describe("rotação 3D", () => {
	const near = (v: readonly number[], w: readonly number[]) => {
		for (let i = 0; i < w.length; i++) expect(v[i]).toBeCloseTo(w[i] as number, 9);
	};

	it("sem ângulos é a identidade", () => {
		near(rotationMatrix(0, 0, 0), IDENTITY);
	});

	it("convenção: +yaw leva a frente para a direita, +pitch para baixo, +roll anti-horário", () => {
		near(applyMat(rotationMatrix(90, 0, 0), 0, 0, 1), [1, 0, 0]);
		near(applyMat(rotationMatrix(0, 90, 0), 0, 0, 1), [0, -1, 0]);
		near(applyMat(rotationMatrix(0, 0, 90), 1, 0, 0), [0, 1, 0]);
	});

	it("R = Rz(roll) · Rx(pitch) · Ry(yaw), como no renderizador de referência", () => {
		const [yaw, pitch, roll] = [30, 20, 10];
		const rad = (d: number) => (d * Math.PI) / 180;
		// yaw, depois pitch, depois roll, aplicados em sequência a um vetor qualquer
		const v: [number, number, number] = [0.3, -0.5, 0.8];
		const ry: [number, number, number] = [
			v[0] * Math.cos(rad(yaw)) + v[2] * Math.sin(rad(yaw)),
			v[1],
			v[2] * Math.cos(rad(yaw)) - v[0] * Math.sin(rad(yaw)),
		];
		const rx: [number, number, number] = [
			ry[0],
			ry[1] * Math.cos(rad(pitch)) - ry[2] * Math.sin(rad(pitch)),
			ry[2] * Math.cos(rad(pitch)) + ry[1] * Math.sin(rad(pitch)),
		];
		const rz: [number, number, number] = [
			rx[0] * Math.cos(rad(roll)) - rx[1] * Math.sin(rad(roll)),
			rx[0] * Math.sin(rad(roll)) + rx[1] * Math.cos(rad(roll)),
			rx[2],
		];
		near(applyMat(rotationMatrix(yaw, pitch, roll), ...v), rz);
	});

	it("é ortonormal: preserva o comprimento", () => {
		const out = applyMat(rotationMatrix(37, -22, 61), 0.4, 0.7, -0.2);
		expect(Math.hypot(...out)).toBeCloseTo(Math.hypot(0.4, 0.7, -0.2), 9);
	});
});

describe("shapes", () => {
	it("tem as 25 formas do catálogo", () => {
		expect(SHAPE_IDS).toHaveLength(25);
		expect(isShape("wedge")).toBe(true);
		expect(isShape("rond")).toBe(false);
	});

	for (const shape of SHAPE_IDS) {
		it(`${shape}: N pontos fixos, dentro da caixa, topo primeiro, sentido horário`, () => {
			const outline = shapeOutline(shape);
			expect(outline).toHaveLength(SHAPE_POINTS * 2);
			for (const value of outline) {
				expect(Number.isFinite(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(-4);
				expect(value).toBeLessThanOrEqual(AVATAR_BOX + 4);
			}
			// Ponto 0: em cima, no meio.
			expect(outline[0]).toBeCloseTo(CENTER, 0);
			expect(outline[1] as number).toBeLessThan(CENTER);
			// Área com sinal positiva = horário (y para baixo).
			let area = 0;
			for (let i = 0; i < SHAPE_POINTS; i++) {
				const j = (i + 1) % SHAPE_POINTS;
				area +=
					(outline[i * 2] as number) * (outline[j * 2 + 1] as number) -
					(outline[j * 2] as number) * (outline[i * 2 + 1] as number);
			}
			expect(area).toBeGreaterThan(0);
		});
	}

	it("é determinístico e memoizado", () => {
		expect(shapeOutline("cloud")).toBe(shapeOutline("cloud"));
		expect(Array.from(shapeOutline("heart"))).toEqual(Array.from(shapeOutline("heart")));
	});

	it("formas diferentes têm contornos diferentes", () => {
		const keys = new Set(SHAPE_IDS.map((s) => Array.from(shapeOutline(s)).slice(0, 40).join(",")));
		expect(keys.size).toBe(SHAPE_IDS.length);
	});
});

describe("morph", () => {
	it("t=0 devolve o primeiro, t=1 o segundo e 0,5 o ponto médio", () => {
		const a = shapeOutline("blob");
		const b = shapeOutline("square");
		expect(lerpOutline(a, b, 0)).toEqual(Array.from(a));
		expect(lerpOutline(a, b, 1)).toEqual(Array.from(b));
		const mid = lerpOutline(a, b, 0.5);
		expect(mid[10]).toBeCloseTo(((a[10] as number) + (b[10] as number)) / 2, 6);
	});

	it("mix normaliza os pesos (70% egg + 30% cloud)", () => {
		const mixed = mixOutlines([
			{ outline: shapeOutline("egg"), weight: 7 },
			{ outline: shapeOutline("cloud"), weight: 3 },
		]);
		const egg = shapeOutline("egg");
		const cloud = shapeOutline("cloud");
		expect(mixed[20]).toBeCloseTo((egg[20] as number) * 0.7 + (cloud[20] as number) * 0.3, 6);
		expect(() => mixOutlines([])).toThrow();
	});
});

describe("olhos por forma", () => {
	it("toda forma tem ajuste e escalas positivas", () => {
		for (const shape of SHAPE_IDS) {
			const fit = EYE_FIT[shape];
			expect(fit.width).toBeGreaterThan(0);
			expect(fit.gap).toBeGreaterThan(0);
			const s = eyeScales(shape);
			expect(s.w).toBeGreaterThan(0.5);
			expect(s.h).toBeGreaterThan(0.5);
		}
		expect(eyeScales("hex")).toEqual({ w: 1, h: 1, gap: 1 });
	});
});

describe("olhos na esfera (mapa exponencial)", () => {
	const ring = (r: number, n = 24) =>
		Array.from({ length: n }, (_, i) => [r * Math.cos((i / n) * Math.PI * 2), r * Math.sin((i / n) * Math.PI * 2)]).flat();

	it("todo ponto cai na superfície da esfera unitária", () => {
		for (const [u, v] of [[0, 0], [0.3, 0.1], [-0.5, 0.4], [0.9, -0.2]] as const) {
			const pts = sphereEyePoints(ring(0.2), u, v);
			for (let i = 0; i < pts.length; i += 3) {
				expect(Math.hypot(pts[i] as number, pts[i + 1] as number, pts[i + 2] as number)).toBeCloseTo(1, 9);
			}
		}
	});

	it("o centro do olho vai para o ponto da face (sen θ/θ · direção, cos θ)", () => {
		const pts = sphereEyePoints([0, 0], 0.3, 0);
		expect(pts[0]).toBeCloseTo(Math.sin(0.3), 9);
		expect(pts[1]).toBeCloseTo(0, 9);
		expect(pts[2]).toBeCloseTo(Math.cos(0.3), 9);
	});

	it("preserva o comprimento de arco perto do centro (mapa exponencial)", () => {
		const pts = sphereEyePoints([0.001, 0, -0.001, 0], 0, 0);
		const d = Math.hypot((pts[0] as number) - (pts[3] as number), (pts[1] as number) - (pts[4] as number), (pts[2] as number) - (pts[5] as number));
		expect(d).toBeCloseTo(0.002, 6);
	});

	it("pontos de trás (z < 0) são levados ao limbo; se todos estão atrás, o olho some", () => {
		const front = sphereEyePoints(ring(0.1), 0, 0);
		expect(projectSpherePoints(front, IDENTITY)).not.toBeNull();
		const back = projectSpherePoints(front, rotationMatrix(180, 0, 0));
		expect(back).toBeNull();
		// metade na frente, metade atrás: os de trás encostam no limbo (raio 1)
		const edge = sphereEyePoints(ring(0.3), 1.45, 0);
		const half = projectSpherePoints(edge, IDENTITY) as number[];
		expect(half).not.toBeNull();
		for (let i = 0; i < half.length; i += 2) {
			expect(Math.hypot(half[i] as number, half[i + 1] as number)).toBeLessThanOrEqual(1 + 1e-9);
		}
	});
});

describe("enquadramento por forma (C7)", () => {
	it("pior ponto: o círculo tem raio do corpo e o quadrado passa do canto", () => {
		expect(worstPointRadius(shapeOutline("blob"))).toBeCloseTo(BODY_RADIUS_PX, 0);
		expect(worstPointRadius(shapeOutline("square"))).toBeGreaterThan(BODY_RADIUS_PX * 1.25);
	});

	it("com a escala do pior ponto, o raio máximo de TODA forma é exatamente o alvo", () => {
		for (const shape of SHAPE_IDS) {
			const k = worstPointScale(shape);
			expect(worstPointRadius(shapeOutline(shape)) * k).toBeCloseTo(BODY_RADIUS_PX, 6);
		}
	});

	it("o motor usa a tabela da referência: círculo = 1, quadrado encolhe, estrela cresce", () => {
		expect(shapeScale("blob")).toBe(1);
		expect(shapeScale("square")).toBeCloseTo(1.0413 / 1.17, 6);
		expect(shapeScale("star")).toBeCloseTo(1.4976 / 1.17, 6);
		expect(shapeFit("blob")).toBe(VIEW_FIT);
	});

	it("com o enquadramento, toda forma cabe no viewBox com folga em qualquer giro de ±30°", () => {
		for (const shape of SHAPE_IDS) {
			const fit = shapeFit(shape);
			const outline = shapeOutline(shape);
			let r = 0;
			for (let i = 0; i < outline.length; i += 2) {
				r = Math.max(r, Math.abs((outline[i] as number) - CENTER), Math.abs((outline[i + 1] as number) - CENTER));
			}
			expect(r * fit).toBeLessThan(CENTER * 0.9);
		}
	});
});
