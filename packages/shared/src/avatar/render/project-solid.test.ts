import { describe, expect, it } from "vitest";

import { applyMat, rotationMatrix } from "../geometry/math.js";
import { CENTER, SHAPE_IDS } from "../geometry/shapes.js";
import { SOLID_KIND } from "../geometry/solid.js";
import type { Frame } from "../model/character.js";
import { bounds, insideNonZero, parseSubpaths, type Point2 } from "./path-utils.js";
import { prepare, projectBody, projectEyes } from "./project.js";
import { stillFrame } from "./still.js";

const turned = (shape: string, yaw: number, pitch: number): Frame => ({
	...stillFrame(shape),
	orientation: { yaw, pitch, roll: 0 },
});

const area = (poly: readonly Point2[]) => {
	let a = 0;
	for (let i = 0; i < poly.length; i++) {
		const [x1, y1] = poly[i] as Point2;
		const [x2, y2] = poly[(i + 1) % poly.length] as Point2;
		a += x1 * y2 - x2 * y1;
	}
	return a / 2;
};

/** União "força bruta" de todas as faces (inclusive as de trás), sem fusão de faixas. */
function bruteUnion(frame: Frame): Point2[][] {
	const m = rotationMatrix(frame.orientation.yaw, frame.orientation.pitch, 0);
	const p = prepare(frame);
	const rings = p.rings as { z: number; scale: number }[];
	const n = p.world.count;
	const pt = (i: number, ring: { z: number; scale: number }): Point2 => {
		const x = p.world.cx + ((p.world.pts[i * 2] as number) - p.world.cx) * ring.scale;
		const y = p.world.cy + ((p.world.pts[i * 2 + 1] as number) - p.world.cy) * ring.scale;
		const v = applyMat(m, x, y, ring.z);
		return [CENTER + frame.fit * v[0], CENTER - frame.fit * v[1]];
	};
	const faces: Point2[][] = [];
	for (const ring of [rings[0], rings[rings.length - 1]] as { z: number; scale: number }[]) {
		faces.push(Array.from({ length: n }, (_, i) => pt(i, ring)));
	}
	for (let k = 0; k + 1 < rings.length; k++) {
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const a = rings[k] as { z: number; scale: number };
			const b = rings[k + 1] as { z: number; scale: number };
			faces.push([pt(i, a), pt(j, a), pt(j, b), pt(i, b)]);
		}
	}
	return faces;
}

describe("sólidos em anéis: união das faces da frente", () => {
	for (const shape of SHAPE_IDS.filter((s) => SOLID_KIND[s].type === "extrusion" || SOLID_KIND[s].type === "loft")) {
		it(`${shape}: a união dos subcaminhos é a mesma de TODAS as faces (sem furos nem sobras)`, () => {
			for (const [yaw, pitch] of [[25, 0], [-25, 15], [60, -20], [150, 10]] as const) {
				const frame = turned(shape, yaw, pitch);
				const d = projectBody(frame);
				const polys = parseSubpaths(d);
				expect(polys.length).toBeGreaterThan(0);
				const reference = bruteUnion(frame).map((poly) => (area(poly) < 0 ? [...poly].reverse() : poly));
				const box = bounds(reference);
				let wrong = 0;
				let total = 0;
				for (let i = 0; i < 40; i++) {
					for (let j = 0; j < 40; j++) {
						const x = box.minX + ((i + 0.5) / 40) * box.width;
						const y = box.minY + ((j + 0.5) / 40) * box.height;
						total++;
						const want = reference.some((poly) => insideNonZero(x, y, [poly]));
						if (insideNonZero(x, y, polys) !== want) wrong++;
					}
				}
				expect(wrong / total, `${shape} yaw=${yaw} pitch=${pitch}`).toBeLessThan(0.01);
			}
		});
	}

	it("a espessura aparece: de lado a silhueta é mais larga que a chapa fina (cos·W)", () => {
		const frame = turned("hex", 30, 0);
		const flat = bounds(parseSubpaths(projectBody(turned("hex", 0, 0))));
		const side = bounds(parseSubpaths(projectBody(frame)));
		expect(side.width).toBeGreaterThan(flat.width * Math.cos((30 * Math.PI) / 180) + 8);
		expect(side.height).toBeCloseTo(flat.height, 0);
	});

	it("de costas (180°) a silhueta é a da frente espelhada (mesma área)", () => {
		const front = bounds(parseSubpaths(projectBody(turned("clover", 0, 0))));
		const back = bounds(parseSubpaths(projectBody(turned("clover", 180, 0))));
		expect(back.width).toBeCloseTo(front.width, 0);
		expect(back.height).toBeCloseTo(front.height, 0);
	});
});

describe("revolução e olhos nos sólidos", () => {
	it("revolução: a silhueta de lado não encolhe como uma chapa (mantém a largura)", () => {
		for (const shape of ["pebble", "egg", "gem", "capsule"] as const) {
			const front = bounds(parseSubpaths(projectBody(turned(shape, 0, 0))));
			const side = bounds(parseSubpaths(projectBody(turned(shape, 40, 0))));
			expect(side.width, shape).toBeGreaterThan(front.width * 0.9);
		}
	});

	it("olhos somem quando a face vira de costas (extrusão, revolução e almofada)", () => {
		for (const shape of ["hex", "pebble", "cloud", "tablet"] as const) {
			expect(projectEyes(turned(shape, 180, 0)), shape).toBe("");
		}
	});

	it("extrusão: o olho encurta com o giro (mesma face, projeção)", () => {
		const wide = (yaw: number) => bounds(parseSubpaths(projectEyes(turned("square", yaw, 0)))).width;
		expect(wide(40)).toBeLessThan(wide(0) * 0.9);
	});

	it("desempenho: projetar corpo + olhos gira em poucos décimos de ms por quadro", () => {
		const frames = SHAPE_IDS.map((s) => turned(s, 22, 9));
		const start = performance.now();
		const rounds = 20;
		let chars = 0;
		for (let r = 0; r < rounds; r++) {
			for (const frame of frames) {
				const p = prepare(frame);
				chars += projectBody(frame, undefined, p).length + projectEyes(frame, undefined, p).length;
			}
		}
		const perFrame = (performance.now() - start) / (rounds * frames.length);
		console.log(`projeção: ${perFrame.toFixed(3)} ms/quadro (com prepare), ${(chars / (rounds * frames.length) / 1024).toFixed(1)} KB de path em média`);
		expect(perFrame).toBeLessThan(3);
	});
});
