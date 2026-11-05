import { Character } from "@workspace/shared/avatar/model/character";
import { projectFrame } from "@workspace/shared/avatar/render/project";
import { describe, expect, it } from "vitest";
import { LIST_POSE } from "./avatar-pose";
import { applyPoseToFrame, fadeStartS, introFrame, isAppReady, LAUNCH_IDLE_CLIP, LAUNCH_SIZE_FROM, LAUNCH_SIZE_TO, LAUNCH_TIMING, launchOpacity, launchState } from "./launch-sequence";

const T = LAUNCH_TIMING;
const state = (elapsedS: number, readyAtS: number | null, reducedMotion = false) => launchState({ elapsedS, readyAtS, reducedMotion });

describe("introFrame (a animação de entrada)", () => {
	it("começa idêntico ao splash estático: pose da lista, 92 pt, imagem do splash opaca, rosto neutro", () => {
		for (const t of [0, T.holdS]) {
			const frame = introFrame(t);
			expect(frame.size).toBe(LAUNCH_SIZE_FROM);
			expect(frame.pose.rot).toEqual([LIST_POSE.pitch, LIST_POSE.yaw, LIST_POSE.roll]);
			expect(frame.splashImage).toBe(1);
			expect(frame.happy).toBe(false);
		}
	});

	it("cresce de 92 para 140 pt sem passar de nenhum dos dois e nunca encolhe", () => {
		let previous = introFrame(0).size;
		for (let t = 0; t <= T.introEndS; t += 1 / 60) {
			const { size } = introFrame(t);
			expect(size).toBeGreaterThanOrEqual(previous - 1e-9);
			expect(size).toBeGreaterThanOrEqual(LAUNCH_SIZE_FROM);
			expect(size).toBeLessThanOrEqual(LAUNCH_SIZE_TO);
			previous = size;
		}
		expect(introFrame(T.growEndS).size).toBeCloseTo(LAUNCH_SIZE_TO, 6);
		expect(introFrame(T.introEndS).size).toBeCloseTo(LAUNCH_SIZE_TO, 6);
	});

	it("dá uma volta só (360°) e volta ao repouso de frente, ficando feliz", () => {
		let yawMax = Number.NEGATIVE_INFINITY;
		let yawMin = Number.POSITIVE_INFINITY;
		for (let t = T.spinStartS; t <= T.spinEndS; t += 1 / 60) {
			const yaw = introFrame(t).pose.rot[1];
			yawMax = Math.max(yawMax, yaw);
			yawMin = Math.min(yawMin, yaw);
		}
		expect(yawMax - yawMin).toBeGreaterThan(330);
		expect(yawMax - yawMin).toBeLessThan(400);
		const end = introFrame(T.introEndS);
		expect(((end.pose.rot[1] % 360) + 360) % 360).toBeCloseTo(0, 3);
		expect(end.pose.rot[0]).toBeCloseTo(0, 3);
		expect(end.pose.rot[2]).toBeCloseTo(0, 3);
		expect(end.happy).toBe(true);
	});

	it("o giro é macio: parte e chega devagar, sem salto de yaw entre quadros", () => {
		// O motor devolve o yaw "desenrolado" perto da pose anterior (ex.: 360 vira 0): compara o menor ângulo entre os dois.
		const gap = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
		const yaw = (t: number) => introFrame(t).pose.rot[1];
		let fastest = 0;
		for (let t = 0; t < T.introEndS; t += 1 / 60) fastest = Math.max(fastest, gap(yaw(t + 1 / 60), yaw(t)));
		// 360° em ~1,7 s com easing: o pico fica abaixo de ~11°/quadro (sem tranco), e a partida é bem mais lenta que o pico.
		expect(fastest).toBeLessThan(11);
		expect(gap(yaw(T.spinEndS - 0.3 + 1 / 60), yaw(T.spinEndS - 0.3))).toBeLessThan(fastest);
		expect(gap(yaw(T.spinStartS + 0.1), yaw(T.spinStartS))).toBeLessThan(fastest * 6 * 0.6);
	});

	it("a imagem do splash some em cima do desenho do motor, sem scale: só opacidade", () => {
		expect(introFrame(T.holdS + T.handoffS).splashImage).toBeCloseTo(0, 9);
		expect(introFrame(T.introEndS).pose.squash).toEqual([1, 1]);
	});
});

describe("launchState (fases da abertura)", () => {
	it("pronto rápido: a animação roda inteira e só então vem o fade", () => {
		expect(state(0.5, 0.2).phase).toBe("intro");
		expect(state(T.introEndS - 0.01, 0.2).phase).toBe("intro");
		expect(state(T.introEndS, 0.2).phase).toBe("fade");
		expect(state(T.introEndS + T.fadeS / 2, 0.2).fade).toBeCloseTo(0.5, 6);
		expect(state(T.introEndS + T.fadeS, 0.2).phase).toBe("done");
	});

	it("pronto lento: repouso (idle) em laço até ficar pronto, aí o fade", () => {
		expect(state(3, null).phase).toBe("idle");
		expect(state(5, null).phase).toBe("idle");
		expect(state(5, null).idleT).toBeCloseTo(5 - T.introEndS, 6);
		expect(state(5.5, 5.5).phase).toBe("fade");
		expect(state(5.5 + T.fadeS, 5.5).phase).toBe("done");
	});

	it("teto de segurança: sem ficar pronto, sai aos 8 s", () => {
		expect(fadeStartS(null, false)).toBe(T.safetyS);
		expect(state(T.safetyS - 0.01, null).phase).toBe("idle");
		expect(state(T.safetyS, null).phase).toBe("fade");
		expect(state(T.safetyS + T.fadeS, null).phase).toBe("done");
		// Pronto só depois do teto: já tinha saído.
		expect(fadeStartS(12, false)).toBe(T.safetyS);
	});

	it("reduzir movimento: sem animação, só o tempo mínimo parado e o fade", () => {
		expect(fadeStartS(0, true)).toBe(T.reducedHoldS);
		expect(state(0.1, 0, true).phase).toBe("idle");
		expect(state(T.reducedHoldS, 0, true).phase).toBe("fade");
		expect(state(T.reducedHoldS + T.fadeS, 0, true).phase).toBe("done");
		// Ainda carregando: fica parado até ficar pronto (ou o teto).
		expect(state(3, null, true).phase).toBe("idle");
		expect(state(T.safetyS, null, true).phase).toBe("fade");
	});

	it("a opacidade só cai no fade, de 1 a 0, sem passar dos limites", () => {
		expect(launchOpacity(state(1, null))).toBe(1);
		expect(launchOpacity(state(T.introEndS, 0))).toBe(1);
		const mid = launchOpacity(state(T.introEndS + T.fadeS / 2, 0));
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(1);
		expect(launchOpacity(state(T.introEndS + T.fadeS, 0))).toBe(0);
		expect(launchOpacity(state(20, 0))).toBe(0);
	});

	it("entradas estranhas não quebram", () => {
		expect(state(Number.NaN, null).phase).toBe("intro");
		expect(state(-3, null).phase).toBe("intro");
	});
});

describe("isAppReady", () => {
	it("carregando a sessão: não está pronto", () => {
		expect(isAppReady({ phase: "loading", pathname: "/", synced: false })).toBe(false);
	});

	it("com sessão: pronto só na home sincronizada, não na tela de sincronização", () => {
		expect(isAppReady({ phase: "signed-in", pathname: "/", synced: false })).toBe(false);
		expect(isAppReady({ phase: "signed-in", pathname: "/syncing", synced: false })).toBe(false);
		expect(isAppReady({ phase: "signed-in", pathname: "/syncing", synced: true })).toBe(false);
		expect(isAppReady({ phase: "signed-in", pathname: "/", synced: true })).toBe(true);
		expect(isAppReady({ phase: "signed-in", pathname: "/computer/abc", synced: true })).toBe(true);
	});

	it("sem sessão ou sem servidor: pronto quando o Login ou a Conexão já estão na tela", () => {
		expect(isAppReady({ phase: "signed-out", pathname: "/", synced: false })).toBe(false);
		expect(isAppReady({ phase: "signed-out", pathname: "/login", synced: false })).toBe(true);
		expect(isAppReady({ phase: "no-server", pathname: "/", synced: false })).toBe(false);
		expect(isAppReady({ phase: "no-server", pathname: "/connect", synced: false })).toBe(true);
	});
});

describe("replay com o motor (o que o overlay faz a cada quadro)", () => {
	it("entrada, repouso do motor e saída: todo quadro projeta um corpo e o repouso toca o clipe calmo", () => {
		const character = new Character({ body: "squircle", seed: 0, breathe: false });
		character.setExpression("neutral", { duration: 0 });
		let happy = false;
		let idling = false;
		let lastPhase = "";
		for (let t = 0; t <= 9; t += 1 / 60) {
			const current = launchState({ elapsedS: t, readyAtS: 5, reducedMotion: false });
			character.advance(1 / 60);
			if (current.phase === "intro") {
				const intro = introFrame(current.introT);
				if (intro.happy && !happy) {
					character.setExpression("happy", { duration: 0.25 });
					happy = true;
				}
				const frame = character.frame();
				applyPoseToFrame(frame, intro.pose);
				expect(projectFrame(frame).body.length).toBeGreaterThan(0);
			} else if (current.phase !== "done") {
				if (!idling) {
					character.playClip(LAUNCH_IDLE_CLIP);
					idling = true;
				}
				expect(projectFrame(character.frame()).body.length).toBeGreaterThan(0);
			}
			lastPhase = current.phase;
			if (current.phase === "done") break;
		}
		expect(happy).toBe(true);
		expect(character.clipName).toBe(LAUNCH_IDLE_CLIP);
		expect(lastPhase).toBe("done");
	});
});
