import { describe, expect, it } from "vitest";

import { createAvatarEngine, type AvatarEngine } from "../engine.js";
import { CLIP_DATA } from "./clip-data.js";
import { ClipPlayer, type ClipEvent } from "./clip-player.js";
import {
	BRIDGE_S,
	CLIP_NAMES,
	DEFAULT_ZOOM,
	easeAt,
	getClip,
	posesClose,
	sampleTrack,
	startPose,
	type Keyframe,
} from "./clips.js";
import { STATE_TABLE, ClipBag, shuffleBag, stateDef, type AvatarState } from "./states.js";

describe("easing cubic-bezier", () => {
	it("extremos fixos e ease linear é a identidade", () => {
		for (const ease of [[0.42, 0, 0.58, 1], [0.4, 0, 0.2, 1], [0.8, 0.02, 0.26, 0.94]] as const) {
			expect(easeAt(0, ease)).toBeCloseTo(0, 6);
			expect(easeAt(1, ease)).toBeCloseTo(1, 6);
		}
		for (const x of [0.1, 0.5, 0.9]) expect(easeAt(x, [0.25, 0.25, 0.75, 0.75])).toBeCloseTo(x, 4);
	});

	it("ease-in-out é simétrico no meio e monotônico", () => {
		expect(easeAt(0.5, [0.42, 0, 0.58, 1])).toBeCloseTo(0.5, 4);
		let prev = 0;
		for (let i = 1; i <= 20; i++) {
			const y = easeAt(i / 20, [0.42, 0, 0.58, 1]);
			expect(y).toBeGreaterThanOrEqual(prev);
			prev = y;
		}
	});
});

describe("trilhas de keyframes", () => {
	const track: Keyframe[] = [
		[1, [0, 10], [0.25, 0.25, 0.75, 0.75]],
		[3, [20, 30], [0.42, 0, 0.58, 1]],
	];

	it("antes do primeiro e depois do último vale o extremo; trilha vazia é nula", () => {
		expect(sampleTrack(track, 0)).toEqual([0, 10]);
		expect(sampleTrack(track, 9)).toEqual([20, 30]);
		expect(sampleTrack([], 1)).toBeNull();
	});

	it("entre dois pontos interpola pelo ease do primeiro", () => {
		expect(sampleTrack(track, 2)?.[0]).toBeCloseTo(10, 3);
		expect(sampleTrack(track, 2)?.[1]).toBeCloseTo(20, 3);
	});
});

describe("biblioteca de clipes (dados da referência)", () => {
	it("tem os clipes da tabela de estados", () => {
		for (const def of Object.values(STATE_TABLE)) {
			for (const name of def.clips) expect(CLIP_NAMES, name).toContain(name);
		}
		for (const name of ["Idle_A", "Idle_B", "Idle_D", "Streaming_A", "Streaming_B", "Streaming_C", "Done_A", "Done_B", "Done_C", "Blocked_A", "Blocked_B", "Blocked_C", "Rotation_A", "Rotation_C"]) {
			expect(CLIP_DATA[name], name).toBeDefined();
		}
	});

	it("keyframes em ordem, easing de 4 números e valores finitos", () => {
		for (const [name, clip] of Object.entries(CLIP_DATA)) {
			expect(clip.duration, name).toBeGreaterThan(0);
			for (const track of [clip.rot, clip.pos, clip.scale, clip.squash]) {
				let last = -1;
				for (const [t, value, ease] of track) {
					expect(t, name).toBeGreaterThanOrEqual(last);
					last = t;
					expect(ease, name).toHaveLength(4);
					for (const v of [...value, ...ease]) expect(Number.isFinite(v), name).toBe(true);
				}
			}
		}
	});

	it("valores conhecidos: Idle_B respira de 0,60 a 0,64; Idle_D parte da pose virada", () => {
		const scale = getClip("Idle_B").scale;
		expect(scale.map((k) => k[1][0])).toEqual([0.6, 0.64, 0.6]);
		expect(getClip("Idle_D").rot[0]?.[1][1]).toBeCloseTo(33.29315, 4);
		expect(getClip("Done_A").anchor).toBe(-1);
		expect(startPose(getClip("Idle_B")).zoom).toBe(DEFAULT_ZOOM);
	});
});

describe("tocador de clipes", () => {
	const events = () => {
		const log: ClipEvent[] = [];
		return { log, player: new ClipPlayer((e) => log.push(e)) };
	};

	it("o primeiro clipe corta direto; o seguinte entra por uma ponte de 0,35 s sem saltos", () => {
		const { player } = events();
		player.load("Idle_A");
		for (let i = 0; i < 100; i++) player.advance(0.016);
		const before = player.pose;
		player.load("Done_C");
		expect(player.isSettled).toBe(false);
		let prev = before;
		let steps = 0;
		for (let t = 0; t < BRIDGE_S + 0.05; t += 0.008) {
			player.advance(0.008);
			steps++;
			const p = player.pose;
			// a pose anda aos poucos: nenhum passo salta mais que ~4° ou ~0,05 raio
			expect(Math.abs(p.rot[1] - prev.rot[1])).toBeLessThan(6);
			expect(Math.abs(p.pos[0] - prev.pos[0])).toBeLessThan(0.05);
			prev = p;
		}
		expect(steps).toBeGreaterThan(30);
		expect(player.name).toBe("Done_C");
	});

	it("rotações vão pelo caminho mais curto (nunca dão uma volta inteira para trás)", () => {
		const { player } = events();
		player.load("Idle_A", { phase: 0.95 }); // perto do yaw 360 do fim do Idle_A
		player.load("Idle_B");
		let maxJump = 0;
		let prev = player.pose.rot[1];
		for (let i = 0; i < 60; i++) {
			player.advance(0.01);
			maxJump = Math.max(maxJump, Math.abs(player.pose.rot[1] - prev));
			prev = player.pose.rot[1];
		}
		expect(maxJump).toBeLessThan(15);
	});

	it("dispara expressão, piscada e fim do clipe", () => {
		const { player, log } = events();
		player.load("Idle_B");
		expect(log[0]).toEqual({ type: "expression", name: "neutral" });
		for (let i = 0; i < 500; i++) player.advance(0.01);
		expect(log.some((e) => e.type === "blink")).toBe(true);
		expect(log.some((e) => e.type === "end")).toBe(true);
		expect(player.loops).toBeGreaterThanOrEqual(1);
	});

	it("rest() volta à pose de repouso e assenta", () => {
		const { player } = events();
		player.load("Working_A", { phase: 0.4 });
		for (let i = 0; i < 20; i++) player.advance(0.016);
		player.rest();
		for (let i = 0; i < 60; i++) player.advance(0.016);
		expect(player.isSettled).toBe(true);
		expect(player.pose).toEqual({ rot: [0, 0, 0], pos: [0, 0], squash: [1, 1], zoom: DEFAULT_ZOOM });
	});

	it("poses quase iguais dispensam a ponte", () => {
		expect(posesClose(startPose(getClip("Idle_B")), startPose(getClip("Idle_B")))).toBe(true);
		expect(posesClose(startPose(getClip("Idle_B")), startPose(getClip("Idle_D")))).toBe(false);
	});
});

describe("bolsa de clipes (sorteio sem repetição)", () => {
	const draw = (seed: number, list: readonly string[], n: number) => {
		const bag = new ClipBag(seed);
		return Array.from({ length: n }, () => bag.next(list));
	};

	it("mesma semente, mesma sequência; sementes diferentes variam", () => {
		const list = STATE_TABLE.idle.clips;
		expect(draw(7, list, 60)).toEqual(draw(7, list, 60));
		expect(draw(7, list, 60)).not.toEqual(draw(8, list, 60));
	});

	it("nunca repete o clipe consecutivo (idle com pesos, streaming, trabalho)", () => {
		for (const state of ["idle", "streaming", "working", "finished"] as const) {
			const list = STATE_TABLE[state].clips;
			for (let seed = 1; seed <= 30; seed++) {
				const seq = draw(seed, list, 300);
				for (let i = 1; i < seq.length; i++) expect(seq[i], `${state} seed ${seed} #${i}`).not.toBe(seq[i - 1]);
			}
		}
	});

	it("respeita os pesos da lista: Idle_B aparece 3 vezes mais que Idle_A numa bolsa", () => {
		const bag = shuffleBag(STATE_TABLE.idle.clips, () => 0.5, null);
		expect(bag.filter((n) => n === "Idle_B")).toHaveLength(3);
		expect(bag.filter((n) => n === "Idle_A")).toHaveLength(1);
		expect(bag.filter((n) => n === "Idle_D")).toHaveLength(1);
	});

	it("a bolsa nova não começa pelo último clipe tocado", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const rand = (() => {
				let x = seed;
				return () => ((x = (x * 16807) % 2147483647) / 2147483647);
			})();
			expect(shuffleBag(["A", "B", "C"], rand, "B")[0]).not.toBe("B");
		}
	});
});

describe("estados (tabela da referência)", () => {
	function engine(seed = "estado", extra: Partial<Parameters<typeof createAvatarEngine>[0]> = {}) {
		return createAvatarEngine({ shape: "hex", seed, breathe: false, ...extra });
	}
	const play = (e: AvatarEngine, seconds: number) => {
		for (let t = 0; t < seconds * 1000; t += 16) e.advance(16);
	};

	it("tem os estados do plano, com clipes, rosto, morph e retorno", () => {
		expect(stateDef("streaming").clips).toEqual(["Streaming_A", "Streaming_B", "Streaming_C"]);
		expect(stateDef("finished")).toMatchObject({ face: "happy", next: "idle", clips: ["Done_B", "Done_A"] });
		expect(stateDef("blocked")).toMatchObject({ next: "drowsy", holdSeconds: 120 });
		expect(stateDef("waking")).toMatchObject({ face: "surprised", next: "idle", holdSeconds: 1.6 });
		expect(stateDef("searching").morph).toBe("radar");
		expect(stateDef("waiting").morph).toBe("orbit");
		expect(stateDef("loading").morph).toBe("progress");
		expect(stateDef("idle").compactClips).toEqual(["Idle_B"]);
		expect(stateDef("sleep" as AvatarState)).toBe(STATE_TABLE.sleeping);
	});

	it("finished: toca Done_B, depois Done_A, e volta sozinho para idle", () => {
		const e = engine();
		e.setState("finished");
		const seen = new Set<string>();
		for (let t = 0; t < 8000 && e.behavior.currentState === "finished"; t += 16) {
			e.advance(16);
			if (e.character.clipName) seen.add(e.character.clipName);
		}
		expect([...seen]).toEqual(expect.arrayContaining(["Done_B", "Done_A"]));
		expect(e.behavior.currentState).toBe("idle");
	});

	it("waking: rosto surpreso por 1,6 s e volta ao idle", () => {
		const e = engine();
		e.setState("waking");
		expect(e.character.currentExpression).toBe("surprised");
		play(e, 1.7);
		expect(e.behavior.currentState).toBe("idle");
	});

	it("failed volta ao idle ao fim do clipe; blocked espera 120 s e vira drowsy", () => {
		const f = engine();
		f.setState("failed");
		play(f, 3.5);
		expect(f.behavior.currentState).toBe("idle");
		const b = engine();
		b.setState("blocked");
		play(b, 100);
		expect(b.behavior.currentState).toBe("blocked");
		play(b, 21);
		expect(b.behavior.currentState).toBe("drowsy");
	});

	it("streaming sorteia entre os 3 clipes sem repetir em sequência", () => {
		const e = engine("fala");
		e.setState("streaming");
		const order: string[] = [];
		for (let t = 0; t < 40_000; t += 16) {
			e.advance(16);
			const name = e.character.clipName;
			if (name && order[order.length - 1] !== name) order.push(name);
		}
		expect(new Set(order).size).toBe(3);
		for (let i = 1; i < order.length; i++) expect(order[i]).not.toBe(order[i - 1]);
	});

	it("o rosto do estado vale sobre o do clipe (happy em finished); a prop de expressão vale sobre tudo", () => {
		const e = engine();
		e.setState("finished");
		play(e, 0.5);
		expect(e.character.currentExpression).toBe("happy");
		e.setExpression("sad");
		expect(e.character.currentExpression).toBe("sad");
	});

	it("idle em avatar pequeno (<32 px) só toca o clipe discreto", () => {
		const e = engine("pequeno", { breathe: true, size: 28 });
		const seen = new Set<string>();
		for (let t = 0; t < 60_000; t += 33) {
			e.advance(33);
			if (e.character.clipName) seen.add(e.character.clipName);
		}
		expect([...seen]).toEqual(["Idle_B"]);
	});

	it("a primeira fase do clipe varia com a semente: avatares lado a lado não sincronizam", () => {
		const poses = new Set<string>();
		for (let i = 0; i < 12; i++) {
			const e = engine(`bot-${i}`, { breathe: true });
			poses.add(e.snapshot().scale.toFixed(3) + e.snapshot().orientation.yaw.toFixed(2));
		}
		expect(poses.size).toBeGreaterThan(6);
	});

	it("mesma semente, mesma sequência de clipes", () => {
		const trace = (seed: string) => {
			const e = engine(seed, { breathe: true });
			const order: string[] = [];
			for (let t = 0; t < 60_000; t += 16) {
				e.advance(16);
				const name = e.character.clipName;
				if (name && order[order.length - 1] !== name) order.push(name);
			}
			return order;
		};
		expect(trace("igual")).toEqual(trace("igual"));
		expect(trace("igual").length).toBeGreaterThan(4);
	});
});
