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
