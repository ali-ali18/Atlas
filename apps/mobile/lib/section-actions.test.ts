import { describe, expect, it } from "vitest";
import { canMoveSection, normalizeSectionName, snapshotWithoutSection, swapSectionOrder } from "./section-actions";
import type { SectionRef } from "./home-types";

const sections: SectionRef[] = [
	{ id: "a", name: "A", order: 0 },
	{ id: "b", name: "B", order: 1 },
	{ id: "c", name: "C", order: 2 },
];

describe("swapSectionOrder", () => {
	it("troca order com o vizinho", () => {
		expect(swapSectionOrder(sections, "b", "up")).toEqual([
			{ id: "a", name: "A", order: 1 },
			{ id: "b", name: "B", order: 0 },
			{ id: "c", name: "C", order: 2 },
		]);
		expect(swapSectionOrder(sections, "b", "down")).toEqual([
			{ id: "a", name: "A", order: 0 },
			{ id: "b", name: "B", order: 2 },
			{ id: "c", name: "C", order: 1 },
		]);
	});

	it("recusa fora dos limites", () => {
		expect(swapSectionOrder(sections, "a", "up")).toBeNull();
		expect(swapSectionOrder(sections, "c", "down")).toBeNull();
		expect(swapSectionOrder(sections, "x", "up")).toBeNull();
	});
});

describe("canMoveSection", () => {
	it("espelha os limites", () => {
		expect(canMoveSection(sections, "a", "up")).toBe(false);
		expect(canMoveSection(sections, "a", "down")).toBe(true);
		expect(canMoveSection(sections, "c", "down")).toBe(false);
	});
});

describe("normalizeSectionName", () => {
	it("apara e recusa vazio", () => {
		expect(normalizeSectionName("  Codding  ")).toBe("Codding");
		expect(normalizeSectionName("   ")).toBeNull();
	});
});

describe("snapshotWithoutSection", () => {
	it("remove a seção e solta os bots", () => {
		const next = snapshotWithoutSection(
			{
				sections,
				bots: [
					{ sectionId: "b" },
					{ sectionId: "b" },
					{ sectionId: "a" },
					{ sectionId: null },
				],
			},
			"b",
		);
		expect(next.sections.map((s) => s.id)).toEqual(["a", "c"]);
		expect(next.bots.map((b) => b.sectionId)).toEqual([null, null, "a", null]);
	});
});
