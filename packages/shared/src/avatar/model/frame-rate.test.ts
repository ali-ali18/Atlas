import { describe, expect, it } from "vitest";

import { createAvatarEngine } from "../engine.js";
import { round1 } from "../geometry/math.js";
import { bodyPath } from "../render/path.js";

// 60 fps só para gesto de verdade (toque, pulso, giro, troca de estado/expressão); o resto fica em 30 fps.
describe("taxa de quadros do motor", () => {
	const engine = () => createAvatarEngine({ shape: "blob", seed: "fps", breathe: false });
	const settle = (e: ReturnType<typeof engine>) => {
		for (let t = 0; t < 3000; t += 33) e.advance(33);
	};

	it("em repouso roda a 30 fps (33 ms)", () => {
		const e = engine();
		settle(e);
		expect(e.frameIntervalMs()).toBe(33);
	});

	it("gestos reais ligam os 60 fps (16 ms)", () => {
		const gestures: Array<[string, (e: ReturnType<typeof engine>) => void]> = [
			["toque", (e) => e.poke(0, 0)],
			["pulso", (e) => e.pulse("toolStart", 1)],
			["giro", (e) => e.spin()],
			["estado", (e) => e.setState("searching")],
			["expressão", (e) => e.setExpression("happy")],
			["corpo", (e) => e.setBody("heart")],
		];
		for (const [name, gesture] of gestures) {
			const e = engine();
			settle(e);
			gesture(e);
			expect(e.frameIntervalMs(), name).toBe(16);
		}
	});

	it("progresso, atividade, ênfase e olhar do mouse não ligam os 60 fps", () => {
		const e = engine();
		settle(e);
		e.setProgress(0.4);
		e.setActivity("read");
		e.setEmphasis(true);
		e.setGaze({ x: 0.5, y: 0.2 });
		expect(e.frameIntervalMs()).toBe(33);
	});

	it("os 60 fps acabam sozinhos depois de ~1,5 s", () => {
		const e = engine();
		settle(e);
		e.poke(0, 0);
		for (let t = 0; t < 1600; t += 16) e.advance(16);
		expect(e.frameIntervalMs()).toBe(33);
	});
});

describe("precisão do d do corpo", () => {
	it("uma casa decimal: variação menor que 0,05 unidade repete a mesma string (sem escrita no DOM)", () => {
		expect(round1(10.012)).toBe(round1(10.03));
		expect(bodyPath([10.012, 20.01, 30.02, 40.04])).toBe(bodyPath([10.03, 20.04, 30.0, 40.02]));
	});
	it("variação visível (>= 0,1) continua mudando a string", () => {
		expect(bodyPath([10, 20, 30, 40])).not.toBe(bodyPath([10.2, 20, 30, 40]));
	});
});
