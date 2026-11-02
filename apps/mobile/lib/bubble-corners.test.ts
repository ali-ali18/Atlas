import { describe, expect, it } from "vitest";
import { bubbleCorners } from "./bubble-corners";

const radii = (c: ReturnType<typeof bubbleCorners>) => [c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomRightRadius, c.borderBottomLeftRadius];

describe("cantos do balão (21 dp só no app)", () => {
	it("sozinho: tudo arredondado em 21", () => {
		expect(radii(bubbleCorners("left", "single"))).toEqual([21, 21, 21, 21]);
		expect(radii(bubbleCorners("right", "single"))).toEqual([21, 21, 21, 21]);
	});
	it("bot (esquerda): a ponta junto da vizinha fica pequena", () => {
		expect(radii(bubbleCorners("left", "first"))).toEqual([21, 21, 21, 6]);
		expect(radii(bubbleCorners("left", "middle"))).toEqual([6, 21, 21, 6]);
		expect(radii(bubbleCorners("left", "last"))).toEqual([6, 21, 21, 21]);
	});
	it("usuário (direita): espelhado", () => {
		expect(radii(bubbleCorners("right", "first"))).toEqual([21, 21, 6, 21]);
		expect(radii(bubbleCorners("right", "middle"))).toEqual([21, 6, 6, 21]);
		expect(radii(bubbleCorners("right", "last"))).toEqual([21, 6, 21, 21]);
	});
});

import { cornersNextToTable } from "./bubble-corners";

describe("balão colado numa tabela", () => {
	it("tabela embaixo: a ponta de baixo à esquerda vira 21, mesmo numa sequência", () => {
		expect(radii(cornersNextToTable(bubbleCorners("left", "middle"), "left", false, true))).toEqual([6, 21, 21, 21]);
	});
	it("tabela em cima: a ponta de cima à esquerda vira 21", () => {
		expect(radii(cornersNextToTable(bubbleCorners("left", "last"), "left", true, false))).toEqual([21, 21, 21, 21]);
	});
	it("sem tabela por perto nada muda", () => {
		const base = bubbleCorners("left", "first");
		expect(cornersNextToTable(base, "left", false, false)).toEqual(base);
	});
});
