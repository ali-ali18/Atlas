import { expect, test } from "vitest";
import { effectivePageGroupIds, formatPageCount, groupPagesForDisplay } from "./page-groups.js";

test("grupo efetivo: o explícito vence; sem ele vale o da rotina ligada; senão nenhum", () => {
	const map = effectivePageGroupIds(
		[{ id: "p1", groupId: "g-explicit" }, { id: "p2" }, { id: "p3", groupId: null }, { id: "p4" }],
		[
			{ pageId: "p1", groupId: "g-routine" },
			{ pageId: "p2", groupId: "g-routine" },
			{ pageId: "p3", groupId: null },
			{ pageId: null, groupId: "g-routine" },
		],
	);
	expect(map.get("p1")).toBe("g-explicit");
	expect(map.get("p2")).toBe("g-routine");
	expect(map.get("p3")).toBe(null);
	expect(map.get("p4")).toBe(null);
});

test("seções: ordem dos grupos, vazios somem, sem grupo por último e grupo apagado cai em sem grupo", () => {
	const items = [
		{ id: "a", groupId: "g2" },
		{ id: "b", groupId: null },
		{ id: "c", groupId: "g1" },
		{ id: "d", groupId: "g-apagado" },
		{ id: "e", groupId: "g2" },
	];
	const sections = groupPagesForDisplay(items, [{ id: "g1" }, { id: "g2" }, { id: "g3" }]);
	expect(sections.map((section) => [section.groupId, section.items.map((item) => item.id)])).toEqual([
		["g1", ["c"]],
		["g2", ["a", "e"]],
		[null, ["b", "d"]],
	]);
	expect(groupPagesForDisplay([], [{ id: "g1" }])).toEqual([]);
});

test("contagem no singular e no plural", () => {
	expect(formatPageCount(1)).toBe("1 painel");
	expect(formatPageCount(0)).toBe("0 painéis");
	expect(formatPageCount(3)).toBe("3 painéis");
});
