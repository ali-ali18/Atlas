import { describe, expect, it } from "vitest";

import { createAvatarEngine, type AvatarEngine } from "../engine.js";
import { FACE_UNIT } from "../geometry/eyes.js";
import { CENTER } from "../geometry/shapes.js";
import { shapeOutline } from "../geometry/shapes.js";
import { BEHAVIOR_TUNING } from "./behavior.js";
import { CHARACTER_TUNING, Character } from "./character.js";
import { EXPRESSION_EYES, normalizeExpression } from "./expressions.js";

const NEUTRAL_LENGTH = 0.57 * FACE_UNIT; // 0,57 unidades de rosto na forma "hex" (escala 1)

function engine(seed = "bot-1", extra: Partial<Parameters<typeof createAvatarEngine>[0]> = {}) {
	return createAvatarEngine({ shape: "hex", seed, breathe: false, ...extra });
}

/** Avança em passos de `stepMs`, devolvendo os instantes (ms) em que `pred` vira verdadeiro. */
function run(e: AvatarEngine, totalMs: number, stepMs = 8, pred?: (e: AvatarEngine) => boolean) {
	const hits: number[] = [];
	let was = false;
	for (let t = stepMs; t <= totalMs; t += stepMs) {
		e.advance(stepMs);
		const now = pred ? pred(e) : false;
		if (now && !was) hits.push(t);
		was = now;
	}
	return hits;
}

const blinking = (e: AvatarEngine) => e.snapshot().eyes[0].length < NEUTRAL_LENGTH * 0.95;

describe("piscar", () => {
	it("é determinístico com a mesma semente", () => {
		const a = run(engine("x"), 30_000, 8, blinking);
		const b = run(engine("x"), 30_000, 8, blinking);
		expect(a.length).toBeGreaterThan(3);
		expect(a).toEqual(b);
	});

	it("o intervalo entre piscadas fica entre 2 e 6 s (pisca dupla à parte)", () => {
		const hits = run(engine("intervalo"), 120_000, 8, blinking);
		const gaps = hits.slice(1).map((t, i) => t - (hits[i] as number));
		// descarta as piscadas duplas (0,28 s depois da anterior)
		const normal = gaps.filter((g) => g > 1000);
		expect(normal.length).toBeGreaterThan(10);
		for (const gap of normal) {
			expect(gap).toBeGreaterThan(1900);
			expect(gap).toBeLessThan(6500);
		}
		expect(hits[0] as number).toBeGreaterThan(1900);
		expect(hits[0] as number).toBeLessThan(6100);
	});

	it("avatares com ids diferentes não piscam em uníssono", () => {
		const firsts = new Set(
			Array.from({ length: 24 }, (_, i) => run(engine(`bot-${i}`), 7000, 8, blinking)[0]),
		);
		expect(firsts.size).toBeGreaterThan(18);
	});

	it("curva de ~120 ms: 1 → 0,1 → 1", () => {
		const c = new Character({ body: "hex", seed: 1, breathe: false });
		const len = () => c.frame().eyes[0].length;
		expect(len()).toBeCloseTo(NEUTRAL_LENGTH, 4);
		c.blink();
		c.advance(CHARACTER_TUNING.blinkS / 2);
		expect(len()).toBeCloseTo(NEUTRAL_LENGTH * CHARACTER_TUNING.blinkMin, 3);
		c.advance(CHARACTER_TUNING.blinkS / 2 + 0.001);
		expect(len()).toBeCloseTo(NEUTRAL_LENGTH, 4);
		expect(CHARACTER_TUNING.blinkS).toBe(0.12);
	});

	it("em repouso (resting) só pisca raro", () => {
		const e = engine("rest");
		e.setResting(true);
		const hits = run(e, 60_000, 8, blinking);
		const gaps = hits.slice(1).map((t, i) => t - (hits[i] as number)).filter((g) => g > 1000);
		expect(gaps.length).toBeGreaterThan(2);
		for (const gap of gaps) expect(gap).toBeGreaterThan(7500);
	});
});

describe("olhar", () => {
	it("o olhar gira o corpo (yaw/pitch da referência), limitado ao círculo unitário e suavizado", () => {
		const c = new Character({ body: "hex", seed: 1, breathe: false });
		expect(c.frame().orientation).toEqual({ yaw: 0, pitch: 0, roll: 0 });
		c.setGaze({ x: 50, y: 0 });
		c.advance(0.016);
		// suavização de 0,14 por quadro: o primeiro quadro só dá o primeiro passo
		expect(c.frame().orientation.yaw).toBeGreaterThan(0);
		expect(c.frame().orientation.yaw).toBeLessThan(CHARACTER_TUNING.yawSolid * 0.3);
		for (let i = 0; i < 100; i++) c.advance(0.016);
		expect(c.frame().orientation.yaw).toBeCloseTo(CHARACTER_TUNING.yawSolid, 5);
		expect(c.isSettled).toBe(true);
		c.setGaze(null);
		expect(c.isSettled).toBe(false);
		c.advance(0.016);
		const early = c.frame().orientation.yaw;
		expect(early).toBeGreaterThan(0);
		expect(early).toBeLessThan(CHARACTER_TUNING.yawSolid);
		for (let i = 0; i < 100; i++) c.advance(0.016);
		expect(c.frame().orientation.yaw).toBe(0);
		expect(c.isSettled).toBe(true);
	});

	it("olhar para baixo inclina (pitch +) e para a direita gira (yaw +); a esfera gira menos", () => {
		const solid = new Character({ body: "hex", seed: 1, breathe: false });
		const sphere = new Character({ body: "blob", seed: 1, breathe: false });
		for (const c of [solid, sphere]) {
			c.setGaze({ x: 1, y: 1 });
			for (let i = 0; i < 100; i++) c.advance(0.016);
		}
		const f = solid.frame().orientation;
		const g = sphere.frame().orientation;
		// o vetor (1, 1) é normalizado: 1/√2 em cada eixo
		expect(f.yaw).toBeCloseTo(CHARACTER_TUNING.yawSolid * Math.SQRT1_2, 3);
		expect(f.pitch).toBeCloseTo(CHARACTER_TUNING.pitchSolid * Math.SQRT1_2, 3);
		expect(g.yaw).toBeCloseTo(CHARACTER_TUNING.yawSphere * Math.SQRT1_2, 3);
		expect(Math.abs(g.yaw)).toBeLessThan(Math.abs(f.yaw));
		expect(g.pitch).toBeLessThan(f.pitch);
	});

	it("coração e cunha giram menos (ganho da referência)", () => {
		const hex = new Character({ body: "hex", seed: 1, breathe: false });
		const heart = new Character({ body: "heart", seed: 1, breathe: false });
		for (const c of [hex, heart]) {
			c.setGaze({ x: 1, y: 0 });
			for (let i = 0; i < 100; i++) c.advance(0.016);
		}
		expect(heart.frame().orientation.yaw).toBeCloseTo(hex.frame().orientation.yaw * 0.6, 5);
	});

	it("modo aditivo (painel que sempre segue) soma 55% por cima; o corpo continua no clipe", () => {
		const c = new Character({ body: "hex", seed: 1, breathe: false });
		c.setGaze({ x: 1, y: 0 }, true);
		for (let i = 0; i < 100; i++) c.advance(0.016);
		expect(c.frame().orientation.yaw).toBeCloseTo(CHARACTER_TUNING.yawSolid * CHARACTER_TUNING.gazeAdditive, 5);
	});

	it("os olhos só ganham um resíduo pequeno do olhar (≤ 1,5 px)", () => {
		const c = new Character({ body: "hex", seed: 1, breathe: false });
		const base = c.frame().eyes[0];
		c.setGaze({ x: 10, y: 10 });
		for (let i = 0; i < 100; i++) c.advance(0.016);
		const f = c.frame().eyes[0];
		expect(Math.hypot(f.cx - base.cx, f.cy - base.cy)).toBeLessThanOrEqual(1.5);
		expect(Math.hypot(f.cx - base.cx, f.cy - base.cy)).toBeGreaterThan(0.5);
	});

	it("modo compacto não faz olhadas aleatórias", () => {
		const e = engine("compacto", { size: 24 });
		let moved = false;
		for (let i = 0; i < 1000; i++) {
			e.advance(100);
			if (Math.abs(e.snapshot().orientation.yaw) > 0.01) moved = true;
		}
		expect(moved).toBe(false);
	});
});

describe("olhadas por tamanho", () => {
	const moves = (e: AvatarEngine) => {
		let moved = false;
		for (let i = 0; i < 1500; i++) {
			e.advance(100);
			if (Math.abs(e.snapshot().orientation.yaw) > 0.5) moved = true;
		}
		return moved;
	};

	it("lista (48 px) só pisca; avatar grande (64 px+) também olha em volta", () => {
		expect(moves(engine("lista", { size: 48 }))).toBe(false);
		expect(moves(engine("grande", { size: 96 }))).toBe(true);
	});

	it("mesmo pequeno, ainda pisca", () => {
		expect(run(engine("pequeno", { size: 24 }), 20_000, 8, blinking).length).toBeGreaterThan(2);
	});

	it("bodyRev só muda quando o contorno muda", () => {
		const c = new Character({ body: "blob", seed: 1, breathe: false });
		const rev = c.frame().bodyRev;
		for (let i = 0; i < 30; i++) c.advance(0.016);
		expect(c.frame().bodyRev).toBe(rev);
		c.setBody("hex");
		for (let i = 0; i < 100; i++) c.advance(0.016);
		const after = c.frame().bodyRev;
		expect(after).toBeGreaterThan(rev);
		for (let i = 0; i < 30; i++) c.advance(0.016);
		expect(c.frame().bodyRev).toBe(after);
	});
});

describe("cutucada", () => {
	it("dá squash, olha para o ponto e assenta", () => {
		const e = engine("poke");
		e.poke(1, 0);
		let maxSquash = 0;
		let maxYaw = 0;
		for (let i = 0; i < 40; i++) {
			const f = e.advance(16);
			maxSquash = Math.max(maxSquash, f.scaleX - 1);
			maxYaw = Math.max(maxYaw, f.orientation.yaw);
		}
		expect(maxSquash).toBeGreaterThan(0.03);
		expect(maxSquash).toBeLessThan(0.2);
		expect(maxYaw).toBeGreaterThan(10);
		run(e, 6000, 16);
		expect(e.isSettled()).toBe(true);
		expect(e.snapshot().scaleX).toBe(1);
	});

	it("troca a expressão por ~1,6 s e volta ao neutro", () => {
		const e = engine("expr");
		expect(e.character.currentExpression).toBe("neutral");
		e.poke();
		expect(e.character.currentExpression).toBe("happy");
		run(e, 1800, 16);
		expect(e.character.currentExpression).toBe("neutral");
		e.poke();
		expect(e.character.currentExpression).toBe("surprised");
	});

	it("poucas cutucadas não irritam; cinco rápidas irritam", () => {
		const slow = engine("slow");
		for (let i = 0; i < 6; i++) {
			slow.poke();
			run(slow, 1000, 16);
			expect(slow.character.currentExpression).not.toBe("angry");
		}

		const fast = engine("fast");
		for (let i = 0; i < BEHAVIOR_TUNING.angryPokes - 1; i++) {
			fast.poke();
			fast.advance(100);
		}
		expect(fast.behavior.isAngry).toBe(false);
		fast.poke();
		expect(fast.behavior.isAngry).toBe(true);
		expect(fast.character.currentExpression).toBe("angry");
	});

	it("a raiva passa depois de ~4 s e ele se acalma", () => {
		const e = engine("calma");
		for (let i = 0; i < 5; i++) {
			e.poke();
			e.advance(100);
		}
		expect(e.behavior.isAngry).toBe(true);
		run(e, 3800, 16);
		expect(e.behavior.isAngry).toBe(true);
		run(e, 400, 16);
		expect(e.behavior.isAngry).toBe(false);
		expect(e.character.currentExpression).toBe("calm");
		run(e, 1400, 16);
		expect(e.character.currentExpression).toBe("neutral");
		run(e, 6000, 16);
		expect(e.isSettled()).toBe(true);
	});
});

describe("expressões", () => {
	it("tem as 9 do plano, apelidos e cai em neutral se desconhecida", () => {
		for (const name of ["neutral", "happy", "surprised", "sad", "sleepy", "squinted", "calm", "inspecting", "confused"] as const) {
			expect(EXPRESSION_EYES[name]).toBeDefined();
		}
		expect(normalizeExpression("smile")).toBe("happy");
		expect(normalizeExpression("SLEEP")).toBe("sleepy");
		expect(normalizeExpression("idle")).toBe("neutral");
		expect(normalizeExpression("???")).toBe("neutral");
	});

	it("transição interpola largura, altura e curvatura em ~0,28 s", () => {
		const c = new Character({ body: "hex", seed: 1, breathe: false });
		const from = c.frame().eyes[0];
		c.setExpression("happy");
		c.advance(CHARACTER_TUNING.expressionS / 2);
		const mid = c.frame().eyes[0];
		for (let i = 0; i < 30; i++) c.advance(0.016);
		const end = c.frame().eyes[0];
		expect(mid.length).toBeLessThan(from.length);
		expect(mid.length).toBeGreaterThan(end.length);
		expect(mid.bend).toBeGreaterThan(0);
		expect(mid.bend).toBeLessThan(end.bend);
		expect(end.bend).toBeGreaterThan(20);
		expect(c.isSettled).toBe(true);
	});

	it("inspecting e confused têm olhos diferentes entre si", () => {
		for (const name of ["inspecting", "confused"] as const) {
			const c = new Character({ body: "hex", seed: 1, breathe: false });
			c.setExpression(name, { duration: 0 });
			const [l, r] = c.frame().eyes;
			expect(l.length).not.toBeCloseTo(r.length, 1);
		}
	});
});

describe("morph do corpo", () => {
	it("anima até a nova forma e assenta; instant pula a animação", () => {
		const c = new Character({ body: "blob", seed: 1, breathe: false });
		c.setBody("hex");
		const start = c.frame().body;
		expect(start[10]).toBeCloseTo(shapeOutline("blob")[10] as number, 5);
		for (let i = 0; i < 100; i++) c.advance(0.016);
		expect(Array.from(c.frame().body)).toEqual(Array.from(shapeOutline("hex")));
		expect(c.isSettled).toBe(true);
		c.setBody("heart", { instant: true });
		expect(Array.from(c.frame().body)).toEqual(Array.from(shapeOutline("heart")));
	});
});

describe("clipes de repouso, giro e trabalho", () => {
	it("vivo (breathe): toca os clipes de repouso, o zoom respira e nunca assenta", () => {
		const e = engine("breath", { breathe: true });
		let min = 2;
		let max = 0;
		for (let i = 0; i < 1000; i++) {
			const f = e.advance(16);
			min = Math.min(min, f.scale);
			max = Math.max(max, f.scale);
		}
		expect(["Idle_A", "Idle_B", "Idle_D"]).toContain(e.character.clipName);
		// Idle_B: zoom 0,60 → 0,64 (≈ +6,7%); nunca passa do que o viewBox comporta
		expect(max).toBeGreaterThan(1.03);
		expect(max).toBeLessThanOrEqual(1.1);
		expect(min).toBeGreaterThanOrEqual(0.8);
		expect(e.isSettled()).toBe(false);
	});

	it("sem respirar, assenta e o loop pode dormir (nextWake finito)", () => {
		const e = engine("sleep");
		expect(e.isSettled()).toBe(true);
		expect(e.character.clipName).toBeNull();
		const wake = e.nextWakeMs();
		expect(wake).toBeGreaterThan(1900);
		expect(wake).toBeLessThan(6100);
	});

	it("spinSignal: uma volta de yaw (360°) em ~0,9 s, depois assenta", () => {
		const e = engine("spin");
		e.spin();
		let max = 0;
		for (let i = 0; i < 60; i++) max = Math.max(max, e.advance(16).orientation.yaw);
		expect(max).toBeGreaterThan(340);
		run(e, 500, 16);
		expect(e.snapshot().orientation.yaw).toBe(0);
		expect(e.isSettled()).toBe(true);
	});

	it("trabalhando: toca os clipes Working_*; ao parar volta ao repouso e assenta", () => {
		const e = engine("work");
		e.setWorking(true);
		let maxRoll = 0;
		let maxOffset = 0;
		for (let i = 0; i < 400; i++) {
			const f = e.advance(16);
			maxRoll = Math.max(maxRoll, Math.abs(f.orientation.roll), Math.abs(f.orientation.pitch));
			maxOffset = Math.max(maxOffset, Math.abs(f.offsetX), Math.abs(f.offsetY));
		}
		expect(e.character.clipName).toMatch(/^Working_/);
		expect(maxRoll).toBeGreaterThan(5);
		expect(maxOffset).toBeGreaterThan(2);
		expect(e.isSettled()).toBe(false);
		e.setWorking(false);
		// uma olhadinha aleatória pode estar em curso: espera o primeiro instante assentado
		let settled = false;
		for (let t = 0; t < 30_000 && !settled; t += 16) {
			e.advance(16);
			settled = e.isSettled();
		}
		expect(settled).toBe(true);
		expect(e.snapshot().orientation).toEqual({ yaw: 0, pitch: 0, roll: 0 });
		expect(e.snapshot().scale).toBe(1);
	});

	it("emphasis aumenta os olhos", () => {
		const e = engine("emph");
		const before = e.snapshot().eyes[0].length;
		e.setEmphasis(true);
		run(e, 2000, 16);
		expect(e.snapshot().eyes[0].length).toBeGreaterThan(before * 1.05);
	});

	it("o centro do corpo não sai de lugar em repouso", () => {
		const e = engine("centro");
		const f = e.snapshot();
		expect(f.offsetX).toBe(0);
		expect(f.offsetY).toBe(0);
		expect((f.eyes[0].cx + f.eyes[1].cx) / 2).toBeCloseTo(CENTER, 5);
	});
});
