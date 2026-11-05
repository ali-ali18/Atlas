import { describe, expect, it } from "vitest";
import { fadeStops } from "./fade-stops";

describe("fadeStops", () => {
	it("padrão mantém os 3 stops do chat", () => {
		expect(fadeStops("top")).toEqual([
			{ offset: 0, opacity: 1 },
			{ offset: 0.55, opacity: 0.85 },
			{ offset: 1, opacity: 0 },
		]);
		expect(fadeStops("bottom").map((s) => s.opacity)).toEqual([0, 0.15, 1]);
	});
	it("linear tem só 2 stops, opaco na borda e transparente no fim", () => {
		expect(fadeStops("top", "linear")).toEqual([{ offset: 0, opacity: 1 }, { offset: 1, opacity: 0 }]);
		expect(fadeStops("bottom", "linear")).toEqual([{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }]);
	});
});
