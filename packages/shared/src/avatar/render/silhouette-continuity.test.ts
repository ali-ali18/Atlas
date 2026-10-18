import { describe, expect, it } from "vitest";

import { createAvatarEngine } from "../engine.js";
import { DRAWABLE_SHAPES, SHAPE_IDS } from "../geometry/shapes.js";
import { SOLID_KIND } from "../geometry/solid.js";
import type { Frame } from "../model/character.js";
import { parseSubpaths } from "./path-utils.js";
import { projectBody } from "./project.js";
import { stillFrame } from "./still.js";

const rotated = (frame: Frame, yaw: number, pitch: number, roll = 0): Frame => ({
	...frame,
	orientation: { yaw, pitch, roll },
});

/** Função suporte da silhueta: maior extensão em 36 direções (px do viewBox). */
function support(frame: Frame): number[] {
	const pts = parseSubpaths(projectBody(frame)).flat();
	return Array.from({ length: 36 }, (_, k) => {
		const a = (k / 36) * Math.PI * 2;
		return Math.max(...pts.map(([x, y]) => x * Math.cos(a) + y * Math.sin(a)));
	});
}

const gap = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - (b[i] as number))));

describe("silhueta contínua na orientação", () => {
	it("um giro minúsculo não troca a silhueta (de frente x quase de frente)", () => {
		for (const shape of SHAPE_IDS) {
			const frame = stillFrame(shape);
			const flat = support(frame);
			for (const [yaw, pitch] of [
				[0.3, 0],
				[0, 0.3],
			] as const) {
				expect(gap(flat, support(rotated(frame, yaw, pitch))), `${shape} ${yaw}/${pitch}`).toBeLessThan(1.5);
			}
		}
	});

	it("ocioso (30 fps, 40 s): esfera e revolução nunca saltam entre quadros (lajes giram de verdade no Idle_A)", () => {
		for (const shape of DRAWABLE_SHAPES.filter((id) => ["sphere", "revolve"].includes(SOLID_KIND[id].type))) {
			for (const seed of ["commito", "bot-1"]) {
				const engine = createAvatarEngine({ shape, seed, size: 98 });
				let prev: number[] | null = null;
				let worst = 0;
				for (let t = 0; t < 40000; t += 33) {
					const now = support(engine.advance(33));
					if (prev) worst = Math.max(worst, gap(now, prev));
					prev = now;
				}
				expect(worst, `${shape} ${seed}`).toBeLessThan(30);
			}
		}
	}, 120_000);
});
