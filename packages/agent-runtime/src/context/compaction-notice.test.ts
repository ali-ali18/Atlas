import { describe, expect, it } from "vitest";
import { shouldAnnounceCompaction } from "./compaction-notice.js";

describe("shouldAnnounceCompaction", () => {
	it("runs que não são de código nunca avisam", () => {
		expect(shouldAnnounceCompaction(false, { before: 100000, after: 10000 })).toBe(false);
	});
	it("run comum avisa só quando o resumo por modelo aconteceu (e só se foi substancial)", () => {
		expect(shouldAnnounceCompaction(false, { before: 100000, after: 40000 }, true)).toBe(true);
		expect(shouldAnnounceCompaction(false, { before: 100000, after: 90000 }, true)).toBe(false);
		expect(shouldAnnounceCompaction(false, undefined, true)).toBe(false);
	});
	it("código com compactação substancial avisa", () => {
		expect(shouldAnnounceCompaction(true, { before: 100000, after: 40000 })).toBe(true);
	});
	it("compactação leve (>= 80%) não avisa", () => {
		expect(shouldAnnounceCompaction(true, { before: 100000, after: 90000 })).toBe(false);
	});
	it("sem compactação não avisa", () => {
		expect(shouldAnnounceCompaction(true, undefined)).toBe(false);
	});
});
