import { describe, expect, it } from "vitest";

import { loftSurface } from "./loft.js";
import { BODY_RADIUS_PX, SHAPE_IDS, shapeOutline } from "./shapes.js";
import {
	SOLID_KIND,
	convexHull,
	extrusionRings,
	loftRings,
	profileRadius,
	revolveProfile,
	revolveSamples,
	worldOutline,
} from "./solid.js";

describe("tabela de sólidos (valores do app de referência)", () => {
	it("toda forma tem um sólido; blob é a esfera", () => {
		for (const shape of SHAPE_IDS) expect(SOLID_KIND[shape]).toBeDefined();
		expect(SOLID_KIND.blob).toEqual({ type: "sphere" });
	});

	it("extrusões: chapa .36/.22, estrela .3/.18, squircle .28/.11", () => {
		for (const shape of ["hex", "square", "sparkle", "clover", "flower", "house"] as const) {
			expect(SOLID_KIND[shape]).toEqual({ type: "extrusion", halfDepth: 0.36, bevel: 0.22 });
		}
		expect(SOLID_KIND.star).toEqual({ type: "extrusion", halfDepth: 0.3, bevel: 0.18 });
		expect(SOLID_KIND.squircle).toEqual({ type: "extrusion", halfDepth: 0.28, bevel: 0.11 });
	});

	it("almofadas: nuvem .72 e coração .62; revolução nas formas redondas; tablet gira em x", () => {
		expect(SOLID_KIND.cloud).toEqual({ type: "loft", depth: 0.72 });
		expect(SOLID_KIND.heart).toEqual({ type: "loft", depth: 0.62 });
		for (const shape of ["pebble", "egg", "capsule", "cylinder", "gem", "wedge", "teardrop", "shield", "dome", "arch", "leaf"] as const) {
			expect(SOLID_KIND[shape]).toEqual({ type: "revolve", axis: "y" });
		}
		expect(SOLID_KIND.tablet).toEqual({ type: "revolve", axis: "x" });
	});
});

describe("contorno no mundo", () => {
	it("centro na origem, y para cima, semi-extensão mínima", () => {
		const w = worldOutline(shapeOutline("tablet"));
		expect(w.cx).toBeCloseTo(0, 1);
		expect(w.cy).toBeCloseTo(0, 1);
		expect(w.count).toBe(96);
		expect(worldOutline(shapeOutline("tablet"), 2).count).toBe(48);
		// o primeiro ponto do contorno é o topo: y > 0 no mundo (y para cima)
		expect(w.pts[1] as number).toBeGreaterThan(0);
		expect(w.halfMin).toBeCloseTo(w.maxY, 0);
	});
});

describe("anéis", () => {
	it("extrusão: 6 anéis simétricos; a frente é a tampa recuada pelo chanfro", () => {
		const w = worldOutline(shapeOutline("hex"));
		const rings = extrusionRings({ type: "extrusion", halfDepth: 0.36, bevel: 0.22 }, w.halfMin);
		expect(rings).toHaveLength(6);
		for (let i = 0; i < 3; i++) {
			expect((rings[i] as { z: number }).z).toBeCloseTo(-(rings[5 - i] as { z: number }).z, 9);
			expect((rings[i] as { scale: number }).scale).toBeCloseTo((rings[5 - i] as { scale: number }).scale, 9);
		}
		const front = rings[5] as { z: number; scale: number };
		expect(front.z).toBeCloseTo(0.36 * BODY_RADIUS_PX, 6);
		expect(front.scale).toBeCloseTo(1 - (0.22 * BODY_RADIUS_PX) / w.halfMin, 6);
		// os anéis do meio têm escala 1 (a parede lateral reta)
		expect((rings[2] as { scale: number }).scale).toBeCloseTo(1, 9);
		expect((rings[2] as { z: number }).z).toBeCloseTo(-(0.36 - 0.22) * BODY_RADIUS_PX, 6);
	});

	it("almofada: de ponta a ponta encolhe a zero (cos^0,72) e z = ±profundidade", () => {
		const rings = loftRings({ type: "loft", depth: 0.72 });
		expect((rings[0] as { z: number }).z).toBeCloseTo(-0.72 * BODY_RADIUS_PX, 6);
		expect((rings[0] as { scale: number }).scale).toBeCloseTo(0, 6);
		expect((rings[10] as { z: number }).z).toBeCloseTo(0.72 * BODY_RADIUS_PX, 6);
		expect((rings[5] as { scale: number }).scale).toBeCloseTo(1, 9);
		expect((rings[5] as { z: number }).z).toBeCloseTo(0, 9);
	});

	it("superfície da almofada: topo no centro, zero na borda", () => {
		const w = worldOutline(shapeOutline("cloud"));
		const surface = loftSurface(w, { type: "loft", depth: 0.72 });
		expect(surface(w.cx, w.cy)).toBeCloseTo(0.72 * BODY_RADIUS_PX, 6);
		expect(surface(w.maxX + 5, w.cy)).toBeCloseTo(0, 6);
		expect(surface(w.cx + 10, w.cy)).toBeLessThan(0.72 * BODY_RADIUS_PX);
		expect(surface(w.cx + 10, w.cy)).toBeGreaterThan(surface(w.cx + 60, w.cy));
	});
});

describe("revolução", () => {
	it("perfil do círculo: raio máximo no meio e quase zero nos polos", () => {
		const w = worldOutline(shapeOutline("blob"));
		const profile = revolveProfile(w, "y");
		expect(profileRadius(profile, 0)).toBeCloseTo(BODY_RADIUS_PX, 0);
		expect(profileRadius(profile, w.maxY - 1)).toBeLessThan(BODY_RADIUS_PX * 0.3);
		// raio² + altura² ≈ R² em qualquer altura
		for (const y of [-80, -40, 30, 90]) {
			expect(Math.hypot(profileRadius(profile, y), y)).toBeCloseTo(BODY_RADIUS_PX, -1);
		}
	});

	it("tablet gira em torno de x: o raio vem da altura em função de x", () => {
		const w = worldOutline(shapeOutline("tablet"));
		const profile = revolveProfile(w, "x");
		expect(profile.axis).toBe("x");
		expect(profileRadius(profile, 0)).toBeCloseTo(w.maxY, 0);
	});

	it("as amostras ficam sobre a superfície (r² = x² + z² no eixo y)", () => {
		const w = worldOutline(shapeOutline("egg"));
		const profile = revolveProfile(w, "y");
		const s = revolveSamples(profile);
		expect(s.length).toBe(16 * 24 * 3);
		for (let i = 0; i < s.length; i += 3) {
			const r = Math.hypot(s[i] as number, s[i + 2] as number);
			expect(r).toBeCloseTo(profileRadius(profile, s[i + 1] as number), 6);
		}
	});
});

describe("casco convexo", () => {
	it("quadrado com pontos internos: 4 vértices, anti-horário", () => {
		const hull = convexHull([0, 0, 10, 0, 10, 10, 0, 10, 5, 5, 3, 7, 8, 2]);
		expect(hull).toHaveLength(8);
		let area = 0;
		for (let i = 0; i < 4; i++) {
			const j = (i + 1) % 4;
			area += (hull[i * 2] as number) * (hull[j * 2 + 1] as number) - (hull[j * 2] as number) * (hull[i * 2 + 1] as number);
		}
		expect(area / 2).toBeCloseTo(100, 6);
	});
});
