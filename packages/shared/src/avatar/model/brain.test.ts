import { describe, expect, it } from "vitest";

import { createAvatarEngine } from "../engine.js";
import { createBrainBudget } from "./brain-budget.js";
import { hash, rng } from "../geometry/math.js";
import {
	ACTIVITY_FAMILIES,
	BRAIN_LIMITS,
	brainLevel,
	Brain,
	familyOfState,
	type ActivityFamily,
	type BrainOutput,
	type PulseKind,
} from "./brain.js";

const DT = 1 / 60;
const seedOf = (text: string) => hash(text);

/** Roda `seconds` a 60 fps e devolve uma cópia da saída de cada quadro. */
function record(brain: Brain, seconds: number, onFrame?: (t: number) => void): BrainOutput[] {
	const out: BrainOutput[] = [];
	for (let t = 0; t < seconds; t += DT) {
		onFrame?.(t);
		brain.advance(DT);
		out.push({ ...brain.output });
	}
	return out;
}

const series = (frames: BrainOutput[], key: keyof BrainOutput) => frames.map((f) => f[key]);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[]) => {
	const m = mean(xs);
	return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
/** Velocidade média: o quanto o sinal muda de quadro a quadro. */
const speed = (xs: number[]) => mean(xs.slice(1).map((x, i) => Math.abs(x - (xs[i] as number))));

function stats(family: ActivityFamily, seed = "bot-x") {
	const brain = new Brain(seedOf(seed));
	brain.setFamily(family);
	const frames = record(brain, 40).slice(60 * 4); // descarta a subida do peso
	return {
		pitch: mean(series(frames, "pitch")),
		yawStd: std(series(frames, "yaw")),
		gazeXStd: std(series(frames, "gazeX")),
		gazeYMean: mean(series(frames, "gazeY")),
		rollSpeed: speed(series(frames, "roll")),
		squashStd: std(series(frames, "squash")),
		blink: mean(series(frames, "blinkRate")),
	};
}

describe("cérebro do avatar", () => {
	it("é determinístico: mesma semente e mesmos eventos dão exatamente as mesmas saídas", () => {
		const run = (seed: string) => {
			const brain = new Brain(seedOf(seed));
			brain.setFamily("read");
			return record(brain, 20, (t) => {
				if (Math.abs(t - 3) < DT / 2) brain.pulse("toolStart", 1);
				if (Math.abs(t - 6) < DT / 2) brain.setFamily("code");
				if (Math.abs(t - 9) < DT / 2) brain.pulse("toolFail", 0.8);
				if (Math.abs(t - 12) < DT / 2) brain.pulse("toolOk", 0.5);
			});
		};
		expect(run("bot-a")).toEqual(run("bot-a"));
		expect(run("bot-a")).not.toEqual(run("bot-b"));
	});

	it("não depende do tamanho do quadro (passo fixo de 1/60 s por dentro)", () => {
		const total = 3;
		const a = new Brain(seedOf("x"));
		const b = new Brain(seedOf("x"));
		a.setFamily("read");
		b.setFamily("read");
		for (let t = 0; t < total; t += 1 / 30) a.advance(1 / 30);
		for (let t = 0; t < total; t += 1 / 60) b.advance(1 / 60);
		// a rede é caótica: um passo de diferença no fim muda a 3ª casa, não o gesto
		expect(Math.abs(a.output.yaw - b.output.yaw)).toBeLessThan(0.3);
		expect(Math.abs(a.output.gazeX - b.output.gazeX)).toBeLessThan(0.1);
		expect(Math.abs(a.output.weight - b.output.weight)).toBeLessThan(0.01);
	});

	it("fica dentro dos limites numa corrida longa e aleatória (5 min, trocas e pulsos)", () => {
		const random = rng(1234);
		const brain = new Brain(seedOf("estresse"));
		const kinds: PulseKind[] = ["toolStart", "toolOk", "toolFail"];
		const L = BRAIN_LIMITS;
		let frames = 0;
		const violations: string[] = [];
		for (let t = 0; t < 300; t += DT) {
			if (random() < 0.01) brain.setFamily(ACTIVITY_FAMILIES[Math.floor(random() * ACTIVITY_FAMILIES.length)] as ActivityFamily);
			if (random() < 0.03) brain.pulse(kinds[Math.floor(random() * kinds.length)] as PulseKind, random() * 1.5);
			// quadros irregulares, inclusive longos
			brain.advance(random() < 0.02 ? 0.1 + random() * 0.4 : DT * (0.5 + random() * 2));
			// Checagem em JS puro e um expect só no fim: ~18 mil quadros × 12 expects
			// estouravam o timeout de 5 s no runner do CI.
			const o = brain.output;
			const bad: string[] = [];
			for (const [k, v] of Object.entries(o)) if (!Number.isFinite(v)) bad.push(`${k} não é finito`);
			if (Math.abs(o.yaw) > L.yaw) bad.push("yaw");
			if (Math.abs(o.pitch) > L.pitch) bad.push("pitch");
			if (Math.abs(o.roll) > L.roll) bad.push("roll");
			if (Math.abs(o.gazeX) > L.gaze) bad.push("gazeX");
			if (Math.abs(o.gazeY) > L.gaze) bad.push("gazeY");
			if (Math.abs(o.squash) > L.squash) bad.push("squash");
			if (Math.abs(o.breath) > L.breath) bad.push("breath");
			if (o.blinkRate < L.blinkMin || o.blinkRate > L.blinkMax) bad.push("blinkRate");
			if (o.weight < 0 || o.weight > 1) bad.push("weight");
			if (bad.length > 0) violations.push(`t=${t.toFixed(2)}: ${bad.join(", ")}`);
			frames += 1;
		}
		expect(violations).toEqual([]);
		expect(frames).toBeGreaterThan(10_000);
	});

	it("nunca repete: dois trechos do mesmo tamanho nunca são iguais e o sinal varia", () => {
		const brain = new Brain(seedOf("sem-repeticao"));
		brain.setFamily("control");
		const frames = record(brain, 60);
		const yaw = series(frames, "yaw");
		expect(std(yaw.slice(120))).toBeGreaterThan(0.3);
		const window = 60 * 5;
		for (let lag = window; 300 + lag + window <= yaw.length; lag += 60) {
			let diff = 0;
			for (let i = 0; i < window; i++) diff = Math.max(diff, Math.abs((yaw[300 + i] as number) - (yaw[300 + lag + i] as number)));
			expect(diff).toBeGreaterThan(0.2);
		}
	});

	it("famílias diferentes se movem de forma medidamente diferente (Lendo ≠ Programando)", () => {
		const read = stats("read");
		const code = stats("code");
		// programando: cabeça mais baixa, olhar mais para baixo, tremor mais rápido, mais "toques", pisca menos
		expect(code.pitch - read.pitch).toBeGreaterThan(1.5);
		expect(code.gazeYMean).toBeGreaterThan(read.gazeYMean + 0.1);
		expect(code.rollSpeed / read.rollSpeed).toBeGreaterThan(1.8);
		expect(code.squashStd).toBeGreaterThan(read.squashStd * 1.5);
		// lendo: varredura larga dos olhos
		expect(read.gazeXStd).toBeGreaterThan(code.gazeXStd * 1.2);
		expect(code.blink).toBeLessThan(read.blink);
	});

	it("todas as famílias de trabalho diferem entre si em pelo menos uma medida", () => {
		const families = ACTIVITY_FAMILIES.filter((f) => brainLevel(f) > 0);
		const sig = new Map(families.map((f) => {
			const s = stats(f);
			return [f, [s.pitch / 2, s.yawStd, s.gazeXStd * 4, s.rollSpeed * 400, s.squashStd * 60, s.blink * 2, s.gazeYMean * 4]] as const;
		}));
		for (let i = 0; i < families.length; i++) {
			for (let j = i + 1; j < families.length; j++) {
				const a = sig.get(families[i] as ActivityFamily) as readonly number[];
				const b = sig.get(families[j] as ActivityFamily) as readonly number[];
				const dist = Math.hypot(...a.map((v, k) => v - (b[k] as number)));
				expect(dist, `${families[i]} × ${families[j]}`).toBeGreaterThan(0.5);
			}
		}
	});

	it("o mesmo trabalho em bots diferentes não é igual (a semente dá temperamento)", () => {
		const a = new Brain(seedOf("bot-1"));
		const b = new Brain(seedOf("bot-2"));
		a.setFamily("read");
		b.setFamily("read");
		const fa = record(a, 10);
		const fb = record(b, 10);
		const diff = Math.max(...series(fa, "yaw").map((v, i) => Math.abs(v - (series(fb, "yaw")[i] as number))));
		expect(diff).toBeGreaterThan(0.5);
	});

	it("o peso sobe devagar ao trabalhar e volta exatamente a zero ao parar (o loop pode dormir)", () => {
		const brain = new Brain(seedOf("peso"));
		expect(brain.isActive).toBe(false);
		brain.setFamily("code");
		expect(brain.isActive).toBe(true);
		record(brain, 0.3);
		expect(brain.output.weight).toBeGreaterThan(0.05);
		expect(brain.output.weight).toBeLessThan(0.5);
		record(brain, 4);
		expect(brain.output.weight).toBeGreaterThan(0.95);

		brain.setFamily("idle");
		let previous = brain.output.weight;
		let settledAt = -1;
		for (let t = 0; t < 12; t += DT) {
			brain.advance(DT);
			expect(brain.output.weight).toBeLessThanOrEqual(previous + 1e-12);
			previous = brain.output.weight;
			if (!brain.isActive && settledAt < 0) settledAt = t;
		}
		expect(settledAt).toBeGreaterThan(1);
		expect(settledAt).toBeLessThan(10);
		const o = brain.output;
		for (const key of ["yaw", "pitch", "roll", "gazeX", "gazeY", "squash", "breath", "weight"] as const) expect(o[key]).toBe(0);
		expect(o.blinkRate).toBe(1);
	});

	it("pulso: falha balança a cabeça e some; ferramenta que começa dá um aceno curto", () => {
		const brain = new Brain(seedOf("pulso"));
		brain.setFamily("code");
		record(brain, 3);
		const base = std(series(record(brain, 1), "yaw"));
		brain.pulse("toolFail", 1);
		const shake = record(brain, 0.5);
		expect(Math.max(...series(shake, "yaw").map(Math.abs))).toBeGreaterThan(base + 0.5);
		const tail = record(brain, 3);
		expect(Math.max(...series(tail.slice(-30), "yaw").map(Math.abs))).toBeLessThan(Math.max(...series(shake, "yaw").map(Math.abs)));

		// pulso sozinho acorda o cérebro mesmo sem família e depois ele dorme de novo
		const quiet = new Brain(seedOf("pulso-2"));
		expect(quiet.isActive).toBe(false);
		quiet.pulse("toolOk", 1);
		expect(quiet.isActive).toBe(true);
		const frames = record(quiet, 0.4);
		expect(Math.max(...series(frames, "pitch").map(Math.abs))).toBeGreaterThan(0.3);
		record(quiet, 6);
		expect(quiet.isActive).toBe(false);
		expect(quiet.output.pitch).toBe(0);
	});

	it("desligado (avatar pequeno) não gera saída nem acorda o loop", () => {
		const brain = new Brain(seedOf("pequeno"));
		brain.setFamily("search");
		record(brain, 2);
		brain.setEnabled(false);
		expect(brain.isActive).toBe(false);
		expect(brain.output.yaw).toBe(0);
		brain.pulse("toolFail", 1);
		brain.advance(0.5);
		expect(brain.isActive).toBe(false);
		expect(brain.output.weight).toBe(0);
	});

	it("família de cada estado: lendo e programando são famílias diferentes", () => {
		expect(familyOfState("reading")).toBe("read");
		expect(familyOfState("coding")).toBe("code");
		expect(familyOfState("searching")).toBe("search");
		expect(familyOfState("running")).toBe("run");
		expect(familyOfState("controlling")).toBe("control");
		expect(familyOfState("streaming")).toBe("write");
		expect(familyOfState("thinking")).toBe("think");
		expect(familyOfState("waiting")).toBe("wait");
		expect(familyOfState("working")).toBe("work");
		expect(familyOfState("idle")).toBe("idle");
		expect(familyOfState("finished")).toBe("idle");
		expect(familyOfState("failed")).toBe("idle");
		expect(familyOfState("sleep")).toBe("idle");
	});
});

describe("cérebro no motor", () => {
	const make = (extra: { brain?: boolean; size?: number } = {}) =>
		createAvatarEngine({ shape: "heart", seed: "motor", breathe: true, ...extra });
	const play = (e: ReturnType<typeof make>, seconds: number) => {
		for (let t = 0; t < seconds * 1000; t += 16) e.advance(16);
	};

	it("trabalhando, o quadro difere do motor sem cérebro; parado, é idêntico", () => {
		const withBrain = make();
		const without = make({ brain: false });
		play(withBrain, 2);
		play(without, 2);
		expect(JSON.stringify(withBrain.snapshot())).toBe(JSON.stringify(without.snapshot()));
		withBrain.setState("reading");
		without.setState("reading");
		play(withBrain, 4);
		play(without, 4);
		expect(JSON.stringify(withBrain.snapshot())).not.toBe(JSON.stringify(without.snapshot()));
	});

	it("o estado define a família: lendo e programando se movem diferente com a mesma semente e o mesmo clipe", () => {
		const reading = make();
		const coding = make();
		reading.setState("reading");
		coding.setState("coding");
		// reading e coding tocam os mesmos 6 clipes sorteados pela mesma semente: o que muda é o cérebro
		const trail = (e: ReturnType<typeof make>) => {
			const rows: number[] = [];
			for (let t = 0; t < 12_000; t += 16) {
				const f = e.advance(16);
				if (t > 4000) rows.push(f.orientation.pitch);
			}
			return rows;
		};
		const a = trail(reading);
		const b = trail(coding);
		expect(Math.abs(mean(a) - mean(b))).toBeGreaterThan(1);
	});

	it("Lendo, Programando e Mexendo na tela têm rosto próprio sobre os mesmos clipes de trabalho", () => {
		const eyesOf = (state: "reading" | "coding" | "controlling" | "working") => {
			const e = make({ brain: false });
			e.setState(state);
			play(e, 1.5);
			const f = e.snapshot();
			return `${f.eyes[0].length.toFixed(3)}|${f.eyes[1].length.toFixed(3)}|${f.eyes[0].width.toFixed(3)}`;
		};
		const faces = new Set([eyesOf("reading"), eyesOf("coding"), eyesOf("controlling")]);
		expect(faces.size).toBe(3);
	});

	it("o ticker pode dormir: assenta ao voltar para idle e não assenta enquanto o cérebro está ativo", () => {
		// sem respiração (breathe: false) o repouso assenta; com ela o clipe de repouso gira para sempre
		const e = createAvatarEngine({ shape: "heart", seed: "motor", breathe: false });
		e.setState("coding");
		play(e, 5);
		expect(e.isSettled()).toBe(false);
		expect(e.nextWakeMs()).toBe(0);
		e.setState("idle");
		let settled = false;
		for (let t = 0; t < 60_000 && !settled; t += 16) {
			e.advance(16);
			settled = e.isSettled();
		}
		expect(settled).toBe(true);
	});

	it("setActivity força a família e null volta a derivar do estado; pulse acorda o motor parado", () => {
		const e = createAvatarEngine({ shape: "blob", seed: "act", breathe: false });
		play(e, 2);
		expect(e.isSettled()).toBe(true);
		e.setActivity("search");
		expect(e.isSettled()).toBe(false);
		play(e, 3);
		expect(e.brainWeight()).toBeGreaterThan(0.5);
		e.setActivity(null);
		for (let t = 0; t < 30_000 && !e.isSettled(); t += 16) e.advance(16);
		expect(e.isSettled()).toBe(true);
		e.pulse("toolFail", 1);
		expect(e.isSettled()).toBe(false);
		for (let t = 0; t < 30_000 && !e.isSettled(); t += 16) e.advance(16);
		expect(e.isSettled()).toBe(true);
	});

	it("avatar pequeno (< 32 px) não tem cérebro: poupa CPU em listas", () => {
		const e = make({ size: 24 });
		e.setState("coding");
		play(e, 3);
		expect(e.brainWeight()).toBe(0);
		const grande = make({ size: 36 });
		grande.setState("coding");
		play(grande, 3);
		expect(grande.brainWeight()).toBeGreaterThan(0.3);
	});

	it("a taxa de piscadas segue a atividade: lendo pisca menos que mexendo na tela", () => {
		// reading e controlling tocam os mesmos clipes (mesma semente): só o cérebro muda o ritmo
		const blinks = (state: "reading" | "controlling") => {
			const e = createAvatarEngine({ shape: "blob", seed: "piscadas", breathe: true });
			let count = 0;
			const original = e.character.blink.bind(e.character);
			e.character.blink = () => {
				count += 1;
				original();
			};
			e.setState(state);
			for (let t = 0; t < 600_000; t += 33) e.advance(33);
			return count;
		};
		expect(blinks("reading")).toBeLessThan(blinks("controlling") * 0.85);
	});

	it("Esperando você e trabalho genérico não seguram o loop: sem movimento contínuo, só pulsos", () => {
		for (const state of ["waiting", "working"] as const) {
			const e = createAvatarEngine({ shape: "heart", seed: "bateria", breathe: false });
			e.setState(state === "waiting" ? "waiting" : "working");
			// o morph de órbita e os clipes de `working` ainda animam; o que não pode haver é cérebro ativo
			play(e, 3);
			expect(e.brainWeight()).toBe(0);
		}
		expect(brainLevel("wait")).toBe(0);
		expect(brainLevel("work")).toBe(0);
		expect(brainLevel("idle")).toBe(0);
		// com `waiting` e sem clipes, o motor assenta (nada mantém o rAF vivo)
		const e = createAvatarEngine({ shape: "heart", seed: "bateria-2", breathe: false });
		e.setActivity("wait");
		play(e, 2);
		expect(e.isSettled()).toBe(true);
		e.pulse("toolOk", 1);
		expect(e.isSettled()).toBe(false);
		play(e, 6);
		expect(e.isSettled()).toBe(true);
	});

	it("teto global: com 10 avatares trabalhando só `max` cérebros ficam acordados", () => {
		const budget = createBrainBudget(3);
		const engines = Array.from({ length: 10 }, (_, i) =>
			createAvatarEngine({ shape: "blob", seed: `bot-${i}`, breathe: false, budget }),
		);
		for (const e of engines) e.setActivity("code");
		for (const e of engines) play(e, 2);
		const awake = engines.filter((e) => !e.isSettled());
		expect(awake).toHaveLength(3);
		expect(budget.size).toBe(3);
		// quem ficou sem vaga não tem movimento do cérebro
		expect(engines.filter((e) => e.brainWeight() > 0)).toHaveLength(3);
		// ao parar de trabalhar a vaga volta e outro avatar pode usá-la
		for (const e of awake) e.setActivity(null);
		for (const e of awake) for (let t = 0; t < 30_000 && !e.isSettled(); t += 16) e.advance(16);
		expect(budget.size).toBe(0);
		const next = engines.find((e) => e.isSettled());
		next?.setActivity("search");
		expect(budget.size).toBe(1);
	});

	it("dispose devolve a vaga (avatar desmontado não segura o teto)", () => {
		const budget = createBrainBudget(1);
		const a = createAvatarEngine({ shape: "blob", seed: "a", breathe: false, budget });
		const b = createAvatarEngine({ shape: "blob", seed: "b", breathe: false, budget });
		a.setActivity("read");
		b.setActivity("read");
		play(a, 1);
		play(b, 1);
		expect(a.brainWeight()).toBeGreaterThan(0);
		expect(b.brainWeight()).toBe(0);
		a.dispose();
		expect(budget.size).toBe(0);
		b.setActivity(null);
		b.setActivity("read");
		play(b, 1);
		expect(b.brainWeight()).toBeGreaterThan(0);
	});

	it("a taxa de piscadas volta a 1 ao encolher abaixo de 32 px (cérebro desligado)", () => {
		const e = createAvatarEngine({ shape: "blob", seed: "piscada", breathe: true, size: 56 });
		e.setState("coding"); // programando pisca bem menos
		play(e, 4);
		expect(e.behavior.blinkRateNow).toBeLessThan(0.9);
		e.setSize(24);
		expect(e.behavior.blinkRateNow).toBe(1);
		play(e, 1);
		expect(e.behavior.blinkRateNow).toBe(1);
	});

	it("a taxa de piscadas volta a 1 quando o cérebro dorme", () => {
		const e = createAvatarEngine({ shape: "blob", seed: "piscada-2", breathe: false });
		e.setActivity("code");
		play(e, 4);
		expect(e.behavior.blinkRateNow).toBeLessThan(0.9);
		e.setActivity(null);
		for (let t = 0; t < 30_000 && !e.isSettled(); t += 16) e.advance(16);
		expect(e.behavior.blinkRateNow).toBe(1);
	});

	it("skip() também acompanha a família do estado", () => {
		const e = createAvatarEngine({ shape: "blob", seed: "skip", breathe: false });
		expect(e.activityFamily()).toBe("idle");
		e.behavior.setState("coding");
		e.skip(100);
		expect(e.activityFamily()).toBe("code");
		e.behavior.setState("idle");
		e.skip(100);
		expect(e.activityFamily()).toBe("idle");
	});

	it("quem perdeu a disputa tenta de novo a cada quadro quando a vaga libera (sem trocar de família)", () => {
		const budget = createBrainBudget(1);
		const a = createAvatarEngine({ shape: "blob", seed: "a", breathe: false, budget });
		const b = createAvatarEngine({ shape: "blob", seed: "b", breathe: false, budget });
		a.setActivity("read");
		b.setActivity("read");
		play(a, 1);
		play(b, 1);
		expect(b.brainWeight()).toBe(0);
		a.setActivity(null);
		for (let t = 0; t < 30_000 && !a.isSettled(); t += 16) a.advance(16);
		expect(budget.size).toBe(0);
		// a família de b continua "read": só o quadro seguinte basta
		play(b, 1);
		expect(b.brainWeight()).toBeGreaterThan(0);
	});

	it("prioridade: o avatar do chat aberto toma a vaga de um da lista", () => {
		const budget = createBrainBudget(1);
		const low = createAvatarEngine({ shape: "blob", seed: "low", breathe: false, budget });
		const high = createAvatarEngine({ shape: "blob", seed: "high", breathe: false, budget, brainPriority: 2 });
		low.setActivity("code");
		play(low, 1);
		expect(low.brainWeight()).toBeGreaterThan(0);
		high.setActivity("code");
		play(high, 1);
		expect(high.brainWeight()).toBeGreaterThan(0);
		expect(low.brainWeight()).toBe(0);
		// o de prioridade menor não volta a tomar a vaga do maior
		play(low, 1);
		expect(low.brainWeight()).toBe(0);
		expect(budget.size).toBe(1);
	});

	it("avatar parado (suspend: fora da tela ou aba oculta) não segura vaga e reassume ao voltar", () => {
		const budget = createBrainBudget(1);
		const a = createAvatarEngine({ shape: "blob", seed: "a", breathe: false, budget });
		const b = createAvatarEngine({ shape: "blob", seed: "b", breathe: false, budget });
		a.setActivity("search");
		play(a, 1);
		b.setActivity("search");
		play(b, 1);
		expect(b.brainWeight()).toBe(0);
		a.suspend();
		expect(budget.size).toBe(0);
		play(b, 1);
		expect(b.brainWeight()).toBeGreaterThan(0);
		// a volta à tela: a vaga está com b (mesma prioridade), então espera
		play(a, 1);
		expect(a.brainWeight()).toBe(0);
	});

	it("o primeiro pulso do run não se perde: chega antes do estado e vale quando o cérebro liga", () => {
		const frameAfter = (pulse: boolean, waitMs: number) => {
			const budget = createBrainBudget(3);
			const e = createAvatarEngine({ shape: "blob", seed: "pulso", breathe: false, budget });
			play(e, 0.5);
			if (pulse) e.pulse("toolFail", 1);
			for (let t = 0; t < waitMs; t += 16) e.advance(16);
			e.setState("reading");
			for (let t = 0; t < 120; t += 16) e.advance(16);
			return JSON.stringify(e.snapshot().orientation);
		};
		expect(frameAfter(true, 0)).not.toBe(frameAfter(false, 0));
		// pulso velho (mais de 1,5 s antes) não vale
		expect(frameAfter(true, 2500)).toBe(frameAfter(false, 2500));
	});
});
