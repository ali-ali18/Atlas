import { CHART_TYPES, PAGE_NODE_TYPES } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { CHART_DRAWING_OF, CHART_DRAWINGS } from "./chart-data";
import { PAGE_NODE_VIEW_OF, PAGE_NODE_VIEWS } from "./page-nodes";

describe("cobertura de renderização", () => {
	it("todo tipo de nó do painel (PAGE_NODE_TYPES) tem um componente registrado", () => {
		for (const type of PAGE_NODE_TYPES) {
			expect(PAGE_NODE_VIEW_OF[type], `sem componente para o nó "${type}"`).toBeDefined();
			expect(PAGE_NODE_VIEWS).toContain(PAGE_NODE_VIEW_OF[type]);
		}
		// e o mapa não guarda tipo que o shared já não tem
		expect(Object.keys(PAGE_NODE_VIEW_OF).sort()).toEqual([...PAGE_NODE_TYPES].sort());
	});
	it("todo tipo de gráfico (CHART_TYPES) tem um desenho registrado", () => {
		for (const type of CHART_TYPES) {
			expect(CHART_DRAWING_OF[type], `sem desenho para o gráfico "${type}"`).toBeDefined();
			expect(CHART_DRAWINGS).toContain(CHART_DRAWING_OF[type]);
		}
		expect(Object.keys(CHART_DRAWING_OF).sort()).toEqual([...CHART_TYPES].sort());
	});
	it("nenhum tipo de gráfico cai em tabela de dados: todos têm desenho nativo", () => {
		expect(new Set(Object.values(CHART_DRAWING_OF))).toEqual(new Set(CHART_DRAWINGS));
	});
});
