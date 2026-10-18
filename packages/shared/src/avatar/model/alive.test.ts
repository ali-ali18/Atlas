import { describe, expect, it } from "vitest";

import { createAvatarEngine } from "../engine.js";

const wrap = (a: number) => ((a % 360) + 540) % 360 - 180;

/** Maior giro (graus) que o idle alcança em 12 s. */
function maxTurn(opts: Parameters<typeof createAvatarEngine>[0]) {
	const engine = createAvatarEngine(opts);
	engine.setState("idle");
	let max = 0;
	for (let t = 0; t < 12_000; t += 33) {
		const { yaw, pitch } = engine.advance(33).orientation;
		max = Math.max(max, Math.abs(wrap(yaw)), Math.abs(wrap(pitch)));
	}
	return max;
}

describe("repouso vivo", () => {
	it.each([36, 52, 72])("gira em 3D no idle com %ipx", (size) => {
		expect(maxTurn({ shape: "hex", seed: "bot-123", size })).toBeGreaterThan(15);
	});

	it("parado quando breathe=false (lista longa)", () => {
		expect(maxTurn({ shape: "hex", seed: "bot-123", size: 52, breathe: false })).toBe(0);
	});
});
