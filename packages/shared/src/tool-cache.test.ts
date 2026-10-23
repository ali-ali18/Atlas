import { describe, expect, it } from "vitest";
import { parseToolCacheState } from "./tool-cache.js";

describe("parseToolCacheState", () => {
	it("lê o estado gravado e descarta o que não é do formato", () => {
		expect(
			parseToolCacheState({
				turn: 3,
				at: "2026-10-23T12:00:00.000Z",
				segments: [["browser", 7], [], ["routines"]],
				lastUsed: { browser: 3, routines: 2, bad: "x", zero: 0 },
				toolOrder: ["navigate", 1, "list_routines"],
			}),
		).toEqual({
			turn: 3,
			at: "2026-10-23T12:00:00.000Z",
			segments: [["browser"], ["routines"]],
			lastUsed: { browser: 3, routines: 2 },
			toolOrder: ["navigate", "list_routines"],
		});
	});

	it("ausente, turno inválido ou data inválida = sem estado", () => {
		expect(parseToolCacheState(undefined)).toBeUndefined();
		expect(parseToolCacheState([])).toBeUndefined();
		expect(parseToolCacheState({ turn: 0, at: "2026-10-23T12:00:00.000Z" })).toBeUndefined();
		expect(parseToolCacheState({ turn: 1.5, at: "2026-10-23T12:00:00.000Z" })).toBeUndefined();
		expect(parseToolCacheState({ turn: 1, at: "ontem" })).toBeUndefined();
		expect(parseToolCacheState({ turn: 1, at: "2026-10-23T12:00:00.000Z" })).toEqual({ turn: 1, at: "2026-10-23T12:00:00.000Z", segments: [], lastUsed: {}, toolOrder: [] });
	});

	it("limita o tamanho (ordem de tools até 300)", () => {
		const many = Array.from({ length: 400 }, (_, index) => `tool_${index}`);
		expect(parseToolCacheState({ turn: 1, at: "2026-10-23T12:00:00.000Z", toolOrder: many })!.toolOrder).toHaveLength(300);
	});
});
