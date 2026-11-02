import { describe, expect, it } from "vitest";
import { bubbleRadius, groupPositionAt } from "./bubble-radius.js";

describe("bubbleRadius", () => {
	it("sozinha arredonda tudo; no grupo a ponta que encosta fica pequena", () => {
		expect(bubbleRadius("left", "single")).toBe("rounded-2xl");
		expect(bubbleRadius("left", "first")).toContain("rounded-bl-md");
		expect(bubbleRadius("right", "middle")).toContain("rounded-tr-md");
		expect(bubbleRadius("right", "last")).toContain("rounded-br-2xl");
	});
});

describe("groupPositionAt", () => {
	const kinds = ["user", "user", "user", "assistant", "card", "assistant"];
	const groups = (kind: string) => kind === "user" || kind === "assistant";
	it("agrupa falas seguidas do mesmo autor", () => {
		expect([0, 1, 2, 3, 4, 5].map((i) => groupPositionAt(kinds, i, groups))).toEqual(["first", "middle", "last", "single", "single", "single"]);
	});
	it("separador quebra o grupo", () => {
		expect(groupPositionAt(kinds, 1, groups, (i) => i === 1)).toBe("first");
		expect(groupPositionAt(kinds, 0, groups, (i) => i === 1)).toBe("single");
	});
	it("índice fora da lista é single", () => {
		expect(groupPositionAt(kinds, 9, groups)).toBe("single");
	});
});
