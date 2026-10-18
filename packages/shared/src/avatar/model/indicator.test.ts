import { describe, expect, it } from "vitest";

import { createAvatarEngine } from "../engine.js";
import { CENTER } from "../geometry/shapes.js";
import { projectEyes } from "../render/project.js";
import { renderFrame } from "../render/svg.js";
import { Indicator, indicatorFor } from "./indicator.js";

const run = (ind: Indicator, seconds: number, step = 0.016) => {
	for (let t = 0; t < seconds; t += step) ind.advance(step);
};

describe("morph de indicador", () => {
	it("mapeia os morphs da tabela: thinking→reticências, radar, órbita, progress; os outros ainda sem desenho", () => {
		expect(indicatorFor("thinking")).toBe("dots");
		expect(indicatorFor("radar")).toBe("radar");
		expect(indicatorFor("orbit")).toBe("orbit");
		expect(indicatorFor("progress")).toBe("progress");
		expect(indicatorFor("writing")).toBeNull();
		expect(indicatorFor(undefined)).toBeNull();
	});

	it("o corpo vira o indicador em ~0,4 s e volta sozinho; depois assenta", () => {
		const ind = new Indicator();
		expect(ind.isSettled).toBe(true);
		expect(ind.frame()).toBeNull();
		ind.set("radar");
		run(ind, 0.1);
		const mid = ind.frame();
		expect(mid?.amount).toBeGreaterThan(0.1);
		expect(mid?.amount).toBeLessThan(1);
		run(ind, 0.6);
		const full = ind.frame();
		expect(full?.amount).toBeGreaterThan(0.99);
		expect(full?.faceVisible).toBe(false);
		// o núcleo encolhe para ~17% do corpo (19 / 114,27 da referência)
		expect(full?.core).toBeCloseTo(19 / 114.2705, 2);
		expect(full?.round).toBeCloseTo(1, 2);
		ind.set(null);
		run(ind, 1.5);
		expect(ind.frame()).toBeNull();
		expect(ind.isSettled).toBe(true);
	});

	it("o rosto só some depois da metade do caminho", () => {
		const ind = new Indicator();
		ind.set("orbit");
		ind.advance(0.016);
		expect(ind.frame()?.faceVisible).toBe(true);
		run(ind, 0.5);
		expect(ind.frame()?.faceVisible).toBe(false);
	});

	it("radar: 3 anéis que crescem do núcleo até ~104 e esmaecem", () => {
		const ind = new Indicator();
		ind.set("radar");
		run(ind, 1.2);
		const parts = ind.frame()?.parts ?? [];
		expect(parts).toHaveLength(3);
		for (const part of parts) {
			expect(part.type).toBe("ring");
			if (part.type === "ring") {
				expect(part.r).toBeGreaterThan(0);
				expect(part.r).toBeLessThanOrEqual(104 * 0.77 + 0.01);
				expect(part.opacity).toBeGreaterThanOrEqual(0);
				expect(part.opacity).toBeLessThanOrEqual(0.9);
			}
		}
		const radii = new Set(parts.map((p) => (p.type === "ring" ? Math.round(p.r) : 0)));
		expect(radii.size).toBe(3);
	});

	it("órbita: 5 discos numa elipse (0,42 de achatamento) girando ao redor do núcleo", () => {
		const ind = new Indicator();
		ind.set("orbit");
		run(ind, 1);
		const parts = ind.frame()?.parts ?? [];
		expect(parts).toHaveLength(5);
		for (const p of parts) {
			expect(p.type).toBe("disc");
			if (p.type === "disc") {
				const dx = (p.cx - CENTER) / 0.77;
				const dy = (p.cy - CENTER) / 0.77;
				expect((dx / 52) ** 2 + (dy / (52 * 0.42)) ** 2).toBeCloseTo(1, 1);
			}
		}
		const before = parts.map((p) => (p.type === "disc" ? p.cx : 0));
		run(ind, 0.3);
		const after = (ind.frame()?.parts ?? []).map((p) => (p.type === "disc" ? p.cx : 0));
		expect(after).not.toEqual(before);
	});

	it("progress: trilha + arco que enche até 100% (~2,1 s), some e recomeça", () => {
		const ind = new Indicator();
		ind.set("progress");
		run(ind, 0.8);
		const early = ind.frame()?.parts ?? [];
		expect(early).toHaveLength(2);
		const arc = (parts: typeof early) => parts.find((p) => p.type === "ring" && p.arc);
		const a1 = arc(early);
		expect(a1 && a1.type === "ring" ? a1.arc?.fraction : 0).toBeGreaterThan(0.2);
		expect(a1 && a1.type === "ring" ? a1.arc?.startDeg : 0).toBe(-90);
		run(ind, 1.5);
		const late = arc(ind.frame()?.parts ?? []);
		expect(late && late.type === "ring" ? late.arc?.fraction : 0).toBe(1);
		// fim do ciclo (2,5 s a 4 s): o indicador some e depois volta
		run(ind, 1.2);
		expect(ind.frame()?.amount ?? 0).toBeLessThan(0.2);
		run(ind, 1.6);
		expect(ind.frame()?.amount ?? 0).toBeGreaterThan(0.5);
	});

	it("reticências (thinking): núcleo + 2 discos que pulam em ondas", () => {
		const ind = new Indicator();
		ind.set("dots");
		run(ind, 1);
		const parts = ind.frame()?.parts ?? [];
		expect(parts).toHaveLength(2);
		const ys = new Set<number>();
		for (let i = 0; i < 90; i++) {
			ind.advance(0.016);
			for (const p of ind.frame()?.parts ?? []) ys.add(Math.round(p.cy * 10));
		}
		expect(ys.size).toBeGreaterThan(5);
	});
});

describe("estados com indicador no motor", () => {
	const engine = () => createAvatarEngine({ shape: "heart", seed: "ind", breathe: false });
	const play = (e: ReturnType<typeof engine>, s: number) => {
		for (let t = 0; t < s * 1000; t += 16) e.advance(16);
	};

	it("searching vira radar: corpo encolhe num círculo, olhos somem e saem anéis", () => {
		const e = engine();
		e.setState("searching");
		play(e, 1);
		const f = e.snapshot();
		expect(f.indicator?.kind).toBe("radar");
		expect(f.shape).toBe("blob");
		expect(f.fit).toBeLessThan(0.77 * 0.3);
		expect(projectEyes(f)).toBe("");
		const svg = renderFrame(f, { color: "#FF6700", id: "x" });
		expect((svg.match(/<circle/g) ?? []).length).toBe(3);
	});

	it("waiting vira órbita; loading, anel de progresso; thinking, reticências", () => {
		for (const [state, kind] of [["waiting", "orbit"], ["loading", "progress"], ["thinking", "dots"]] as const) {
			const e = engine();
			e.setState(state);
			play(e, 1);
			expect(e.snapshot().indicator?.kind, state).toBe(kind);
		}
	});

	it("ao sair do estado o corpo volta, com a forma original, e o loop pode dormir", () => {
		const e = engine();
		e.setState("waiting");
		play(e, 1);
		e.setState("idle");
		let settled = false;
		for (let t = 0; t < 30_000 && !settled; t += 16) {
			e.advance(16);
			settled = e.isSettled();
		}
		expect(settled).toBe(true);
		const f = e.snapshot();
		expect(f.indicator).toBeNull();
		expect(f.shape).toBe("heart");
		expect(projectEyes(f)).not.toBe("");
	});

	it("setMorph pela API do motor", () => {
		const e = engine();
		e.setMorph("radar");
		play(e, 1);
		expect(e.snapshot().indicator?.kind).toBe("radar");
		e.setMorph(null);
		play(e, 1.5);
		expect(e.snapshot().indicator).toBeNull();
	});
});
