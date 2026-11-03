import { describe, expect, it } from "vitest";
import { clampSpan, gapPx, gridColumns, gridItemWidth, isStatsOnly, kanbanLayout } from "./page-layout";

describe("kanban", () => {
	it("celular empilha (colunas recolhíveis); tablet e paisagem põem lado a lado", () => {
		expect(kanbanLayout(0)).toBe("stacked");
		expect(kanbanLayout(379)).toBe("stacked");
		expect(kanbanLayout(671)).toBe("stacked");
		expect(kanbanLayout(672)).toBe("columns");
		expect(kanbanLayout(1000)).toBe("columns");
	});
});

describe("colunas da grade por largura", () => {
	it("celular: 1 coluna; grade só de stat: 2", () => {
		expect(gridColumns(3, 379, false)).toBe(1);
		expect(gridColumns(2, 379, false)).toBe(1);
		expect(gridColumns(4, 379, true)).toBe(2);
		expect(gridColumns(1, 379, true)).toBe(1);
	});
	it("tablet em pé: até 2; paisagem e tablet grande seguem o spec", () => {
		expect(gridColumns(4, 560, false)).toBe(2);
		expect(gridColumns(4, 560, true)).toBe(2);
		expect(gridColumns(3, 800, false)).toBe(3);
		expect(gridColumns(4, 800, true)).toBe(4);
		expect(gridColumns(2, 1024, false)).toBe(2);
	});
	it("ainda sem medida ou cols inválido: 1 coluna", () => {
		expect(gridColumns(3, 0, false)).toBe(1);
		expect(gridColumns(3, Number.NaN, true)).toBe(1);
		expect(gridColumns(Number.NaN, 900, false)).toBe(1);
		expect(gridColumns(9, 900, false)).toBe(4);
		expect(gridColumns(0, 900, false)).toBe(1);
	});
	it("só stat conta como grade de números", () => {
		expect(isStatsOnly(["stat", "stat"])).toBe(true);
		expect(isStatsOnly(["stat", "chart"])).toBe(false);
		expect(isStatsOnly([])).toBe(false);
	});
});

describe("largura dos itens", () => {
	it("divide a linha descontando os espaços", () => {
		expect(gridItemWidth(360, 2, 12, 1)).toBe(174);
		expect(gridItemWidth(360, 2, 12, 2)).toBe(360);
		expect(gridItemWidth(400, 3, 12, 1)).toBe(125);
		expect(gridItemWidth(400, 3, 12, 2)).toBe(262);
	});
	it("arredonda para baixo: duas colunas nunca passam da largura", () => {
		const width = gridItemWidth(375, 2, 12, 1);
		expect(width * 2 + 12).toBeLessThanOrEqual(375);
	});
	it("sem largura medida: 0", () => {
		expect(gridItemWidth(0, 2, 12, 1)).toBe(0);
		expect(gridItemWidth(300, 0, 12, 1)).toBe(0);
	});
	it("span fica entre 1 e o número de colunas; valor estranho vira 1", () => {
		expect(clampSpan(3, 2)).toBe(2);
		expect(clampSpan(0, 3)).toBe(1);
		expect(clampSpan(undefined, 3)).toBe(1);
		expect(clampSpan("2", 3)).toBe(1);
		expect(clampSpan(2.7, 4)).toBe(2);
		expect(clampSpan(Number.NaN, 4)).toBe(1);
	});
	it("espaços: sm 8, md 12 (padrão), lg 20", () => {
		expect([gapPx("sm"), gapPx(undefined), gapPx("lg")]).toEqual([8, 12, 20]);
	});
});
