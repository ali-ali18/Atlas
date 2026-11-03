import { describe, expect, it } from "vitest";
import { inlineText } from "./markdown";
import { columnAlign, pageTableBlock, visibleRows } from "./page-table";

describe("corte de tabelas grandes", () => {
	const rows = Array.from({ length: 100 }, (_, i) => i);
	it("acima de 30 linhas mostra 30 e conta as escondidas; expandido mostra tudo", () => {
		expect(visibleRows(rows, false)).toMatchObject({ hidden: 70 });
		expect(visibleRows(rows, false).rows).toHaveLength(30);
		expect(visibleRows(rows, true)).toEqual({ rows, hidden: 0 });
	});
	it("até o limite não corta (30 exatas e menos)", () => {
		expect(visibleRows(rows.slice(0, 30), false).hidden).toBe(0);
		expect(visibleRows([], false)).toEqual({ rows: [], hidden: 0 });
		expect(visibleRows(rows, false, 10).rows).toHaveLength(10);
	});
});

const columns = [
	{ key: "id", label: "Pedido" },
	{ key: "total", label: "Total", unit: "BRL" },
	{ key: "status", label: "Status", align: "center" as const },
];
const rows = [
	{ id: "#1042", total: 10, status: "Pago" },
	{ id: "#1043", total: 7.5, status: null },
];

describe("tabela do painel como bloco de tabela do chat", () => {
	it("cabeçalho, células formatadas e vazio como traço", () => {
		const { block } = pageTableBlock(columns, rows);
		expect(block.header.map(inlineText)).toEqual(["Pedido", "Total", "Status"]);
		expect(block.rows.map((row) => row.map(inlineText))).toEqual([
			["#1042", "R$ 10,00", "Pago"],
			["#1043", "R$ 7,50", "—"],
		]);
	});
	it("a moeda da coluna usa as mesmas casas em todas as linhas", () => {
		const { block } = pageTableBlock([{ key: "v", label: "V", unit: "BRL" }], [{ v: 100 }, { v: 2000 }]);
		expect(block.rows.map((row) => inlineText(row[0]!))).toEqual(["R$ 100", "R$ 2.000"]);
	});
	it("alinha número à direita, texto à esquerda e respeita o `align` do spec", () => {
		expect(pageTableBlock(columns, rows).aligns).toEqual(["left", "right", "center"]);
		expect(columnAlign({ key: "x", label: "X" }, [{ x: null }, { x: 3 }])).toBe("right");
		expect(columnAlign({ key: "x", label: "X" }, [])).toBe("left");
	});
	it("conteúdo do spec fica como texto puro: markdown e HTML não são interpretados", () => {
		const { block } = pageTableBlock([{ key: "n", label: "**Nome**" }], [{ n: "[x](javascript:alert(1)) <b>oi</b>" }]);
		expect(block.header[0]).toEqual([{ type: "text", text: "**Nome**" }]);
		expect(block.rows[0]?.[0]).toEqual([{ type: "text", text: "[x](javascript:alert(1)) <b>oi</b>" }]);
	});
});
