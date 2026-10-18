import { describe, expect, it } from "vitest";

import { SHAPE_IDS, CENTER } from "../geometry/shapes.js";
import { SOLID_KIND } from "../geometry/solid.js";
import { Character, type Frame } from "../model/character.js";
import { bodyPath, eyesPath } from "./path.js";
import { bounds, insideNonZero, parseSubpaths } from "./path-utils.js";
import { createProjector, projectBody, projectEyes, projectFrame } from "./project.js";
import { stillFrame } from "./still.js";

const withOrientation = (frame: Frame, yaw: number, pitch: number, roll = 0): Frame => ({
	...frame,
	orientation: { yaw, pitch, roll },
});

describe("projeção: orientação 3D", () => {
	it("com yaw = pitch = roll = 0 a silhueta é exatamente a do 2D (todas as formas)", () => {
		for (const shape of SHAPE_IDS) {
			const frame = stillFrame(shape);
			// o enquadramento da forma (fit) escala tudo em torno do centro; nada mais muda
			const scaled = frame.body.map((v) => CENTER + (v - CENTER) * frame.fit);
			expect(frame.fit).toBeGreaterThan(0.5);
			expect(projectBody(frame)).toBe(bodyPath(scaled));
			// Olhos de face reta (extrusão): o mesmo contorno do 2D, na escala do enquadramento.
			if (SOLID_KIND[shape].type === "extrusion") {
				const flat = bounds(parseSubpaths(eyesPath(frame.eyes)));
				const eyes = bounds(parseSubpaths(projectEyes(frame)));
				expect(eyes.width).toBeCloseTo(flat.width * frame.fit, 0);
				expect(eyes.height).toBeCloseTo(flat.height * frame.fit, 0);
			}
		}
	});

	it("esfera de frente: o olho enrolado fica a poucos px do olho plano", () => {
		const frame = stillFrame("blob");
		const flat = parseSubpaths(eyesPath(frame.eyes));
		const wrapped = parseSubpaths(projectEyes(frame));
		expect(wrapped).toHaveLength(2);
		const k = frame.fit;
		for (let e = 0; e < 2; e++) {
			const a = bounds([flat[e] as never]);
			const b = bounds([wrapped[e] as never]);
			expect(Math.abs(CENTER + (a.minX - CENTER) * k - b.minX)).toBeLessThan(3);
			expect(Math.abs(CENTER + (a.maxX - CENTER) * k - b.maxX)).toBeLessThan(3);
			expect(Math.abs(a.height * k - b.height)).toBeLessThan(3);
		}
	});

	it("roll gira no plano da tela (silhueta do 2D girada), sem mudar a área", () => {
		const frame = stillFrame("hex");
		const flat = parseSubpaths(projectBody(frame))[0] as readonly (readonly [number, number])[];
		const turned = parseSubpaths(projectBody(withOrientation(frame, 0, 0, 90)))[0] as readonly (readonly [number, number])[];
		const area = (p: typeof flat) => {
			let a = 0;
			for (let i = 0; i < p.length; i++) {
				const [x1, y1] = p[i] as [number, number];
				const [x2, y2] = p[(i + 1) % p.length] as [number, number];
				a += x1 * y2 - x2 * y1;
			}
			return Math.abs(a / 2);
		};
		expect(area(turned)).toBeCloseTo(area(flat), 0);
		const b0 = bounds([flat]);
		const b1 = bounds([turned]);
		expect(b1.width).toBeCloseTo(b0.height, 0);
	});

	it("yaw estreita a silhueta (cos) e mantém a altura", () => {
		const frame = stillFrame("squircle");
		const b0 = bounds(parseSubpaths(projectBody(frame)));
		const b1 = bounds(parseSubpaths(projectBody(withOrientation(frame, 25, 0))));
		expect(b1.height).toBeCloseTo(b0.height, 0);
		expect(b1.width).toBeLessThan(b0.width * 0.99);
	});

	it("o projetor reaproveita o corpo quando só o olho muda", () => {
		const project = createProjector();
		const c = new Character({ body: "hex", seed: 1, breathe: false });
		const a = project(c.frame());
		c.blink();
		c.advance(0.06);
		const b = project(c.frame());
		expect(b.body).toBe(a.body);
		expect(b.eyes).not.toBe(a.eyes);
	});

	it("os olhos ficam dentro da silhueta com yaw/pitch em ±25° (todas as formas)", () => {
		const angles = [-25, -12, 0, 12, 25];
		for (const shape of SHAPE_IDS) {
			const base = stillFrame(shape);
			for (const yaw of angles) {
				for (const pitch of angles) {
					const { body, eyes } = projectFrame(withOrientation(base, yaw, pitch));
					const silhouette = parseSubpaths(body);
					for (const eye of parseSubpaths(eyes)) {
						for (const [x, y] of eye) {
							expect(
								insideNonZero(x, y, silhouette),
								`${shape} yaw=${yaw} pitch=${pitch} ponto (${x}, ${y}) fora`,
							).toBe(true);
						}
					}
				}
			}
		}
	});

	it("esfera: ao virar, o olho do lado de trás é cortado e o da frente encurta (perspectiva)", () => {
		const frame = stillFrame("blob");
		const front = parseSubpaths(projectEyes(frame));
		expect(front).toHaveLength(2);
		const width = (poly: unknown) => bounds([poly as never]).width;
		// 55° para a direita: o olho esquerdo vai para o centro/lado visível e o direito para o limbo
		const turned = parseSubpaths(projectEyes(withOrientation(frame, 55, 0)));
		const widths = turned.map(width);
		expect(Math.min(...widths)).toBeLessThan(width(front[0]) * 0.75);
		// de costas (180°) os dois olhos somem: nada de olho desenhado atrás do corpo
		expect(projectEyes(withOrientation(frame, 180, 0))).toBe("");
		// de lado (90°) só o olho da frente continua visível
		expect(parseSubpaths(projectEyes(withOrientation(frame, 90, 0))).length).toBeLessThanOrEqual(1);
	});

	it("esfera: a silhueta não muda com yaw/pitch (é sempre o círculo)", () => {
		const frame = stillFrame("blob");
		expect(projectBody(withOrientation(frame, 40, -20))).toBe(projectBody(frame));
	});

	it("o centro do avatar fica no centro do viewBox em repouso", () => {
		const frame = stillFrame("blob");
		const b = bounds(parseSubpaths(projectBody(frame)));
		expect((b.minX + b.maxX) / 2).toBeCloseTo(CENTER, 0);
		expect((b.minY + b.maxY) / 2).toBeCloseTo(CENTER, 0);
	});
});
