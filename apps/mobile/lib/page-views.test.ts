import type { PageNodePropsMap } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import {
	barListView,
	calloutView,
	cardLook,
	headingStyle,
	isStatusColumn,
	kanbanView,
	listView,
	mergeRowHeight,
	pinFirstColumn,
	progressView,
	SECTION_GAP,
	stackGap,
	statView,
	tableColumnWidth,
	tableView,
	timelineView,
	verdictTone,
} from "./page-views";

describe("espaço entre filhos", () => {
	it("o gap do spec vale, e entre seções o painel respira mais", () => {
		expect(stackGap(undefined, ["stat", "chart"])).toBe(12);
		expect(stackGap("sm", ["card"])).toBe(8);
		expect(stackGap("lg", ["section", "section"])).toBe(SECTION_GAP);
		expect(stackGap("md", ["section", "section"])).toBe(SECTION_GAP);
		expect(stackGap("md", ["section"])).toBe(12);
		expect(stackGap("md", ["section", "text"])).toBe(12);
	});
});

describe("cartão", () => {
	it("outlined (padrão) tem borda e fundo do cartão; filled só o fundo suave; plain nada", () => {
		expect(cardLook({})).toEqual({ padded: true, border: true, fill: "card", tone: null });
		expect(cardLook({ variant: "filled" })).toEqual({ padded: true, border: false, fill: "muted", tone: null });
		expect(cardLook({ variant: "plain" })).toEqual({ padded: false, border: false, fill: "none", tone: null });
	});
	it("tom neutro não pinta o cartão; outro tom sim", () => {
		expect(cardLook({ tone: "neutral" }).tone).toBeNull();
		expect(cardLook({ tone: "warning" }).tone).toBe("warning");
	});
});

describe("métrica (stat)", () => {
	it("número grande, legenda embaixo, texto livre como veio", () => {
		const view = statView({ label: "Itens conferidos", value: "15 de 15" });
		expect(view).toMatchObject({ value: "15 de 15", label: "Itens conferidos", fontSize: 30, delta: null, tone: undefined });
		expect(view.accessibilityLabel).toBe("Itens conferidos, 15 de 15");
	});
	it("formata moeda, tamanhos e encolhe valor longo", () => {
		expect(statView({ label: "Receita", value: 128450.5, unit: "BRL" }).value).toBe("R$ 128.450,50");
		expect(statView({ label: "Receita", value: 128450.5, unit: "BRL", size: "lg" }).fontSize).toBe(26);
		expect(statView({ label: "Itens", value: 12, size: "sm" }).fontSize).toBe(24);
		expect(statView({ label: "Itens", value: 12, size: "lg" }).fontSize).toBe(40);
	});
	it("variação leva seta, sinal e o tom da direção", () => {
		const up = statView({ label: "Vendas", value: 10, delta: { value: 8, direction: "up", label: "vs meta" } });
		expect(up.delta).toEqual({ text: "▲ 8% vs meta", tone: "positive" });
		expect(statView({ label: "V", value: 1, delta: { value: 3, direction: "down" } }).delta?.tone).toBe("critical");
		expect(statView({ label: "V", value: 1, delta: { value: 0, direction: "flat" } }).delta).toEqual({ text: "—", tone: "neutral" });
		expect(up.accessibilityLabel).toBe("Vendas, 10, ▲ 8% vs meta");
	});
	it("o tom do spec colore o valor", () => {
		expect(statView({ label: "A", value: 1, tone: "critical" }).tone).toBe("critical");
	});
});

describe("lista de barras e progresso", () => {
	it("a maior barra é 100%, números no mesmo formato, 'display' vence", () => {
		const view = barListView({ items: [{ label: "A", value: 10 }, { label: "B", value: 5.5 }, { label: "C", value: 0, display: "n/d" }], unit: "BRL" });
		expect(view.tone).toBe("accent");
		expect(view.rows.map((row) => [row.label, row.shown, row.percent])).toEqual([["A", "R$ 10,00", 100], ["B", "R$ 5,50", 55], ["C", "n/d", 0]]);
	});
	it("progresso: porcentagem, barra e 'x de y'", () => {
		const view = progressView({ label: "Meta", value: 62000, max: 100000, unit: "BRL", tone: "positive" });
		expect(view).toMatchObject({ percentText: "62%", percent: 62, detail: "R$ 62.000 de R$ 100.000", now: 62000, max: 100000, tone: "positive" });
	});
	it("passou da meta: barra cheia, valor de acessibilidade travado no máximo", () => {
		const view = progressView({ label: "Meta", value: 150, max: 100 });
		expect(view).toMatchObject({ percentText: "150%", percent: 100, now: 100 });
	});
});

describe("aviso (callout)", () => {
	it("ícone e tom seguem o tipo; título é opcional", () => {
		expect(calloutView({ tone: "warning", text: "Falta o item" })).toEqual({ tone: "warning", icon: "warning", title: undefined, text: "Falta o item" });
		expect(calloutView({ tone: "info", title: "Nota", text: "x" })).toMatchObject({ tone: "accent", icon: "info", title: "Nota" });
		expect(calloutView({ tone: "success", text: "x" }).tone).toBe("positive");
		expect(calloutView({ tone: "critical", text: "x" }).tone).toBe("critical");
	});
});

describe("veredito na tabela", () => {
	it("palavras de estado têm tom; o resto não", () => {
		expect(verdictTone("Confirmado")).toBe("positive");
		expect(verdictTone("  concluída ")).toBe("positive");
		expect(verdictTone("Parcial")).toBe("warning");
		expect(verdictTone("Em andamento")).toBe("warning");
		expect(verdictTone("Reprovado")).toBe("critical");
		expect(verdictTone("Atrasado")).toBe("critical");
		expect(verdictTone("Maria Silva")).toBeNull();
		// palavras neutras: sem julgamento
		for (const text of ["Sim", "Não", "Ativo", "Inativo", "OK"]) expect(verdictTone(text), text).toBeNull();
		expect(verdictTone("Não feita")).toBe("critical");
		expect(verdictTone("")).toBeNull();
	});
	it("só coluna curta, com poucos valores e ao menos um veredito conhecido é de status", () => {
		expect(isStatusColumn(["Confirmado", "Parcial", "Confirmado"])).toBe(true);
		expect(isStatusColumn(["Confirmado", null, "Parcial"])).toBe(true);
		expect(isStatusColumn(["Maria", "João"])).toBe(false);
		expect(isStatusColumn(["Confirmado", "Um texto bem longo que não é veredito nenhum"])).toBe(false);
		expect(isStatusColumn(["Confirmado", 3])).toBe(false);
		expect(isStatusColumn([])).toBe(false);
		// pergunta neutra: Sim/Não não vira coluna de status
		expect(isStatusColumn(["Sim", "Não", "Sim"])).toBe(false);
		expect(isStatusColumn(["Ativo", "Inativo"])).toBe(false);
		expect(isStatusColumn(["a", "b", "c", "d", "e", "f", "g", "Parcial"])).toBe(false);
	});
});

const table: PageNodePropsMap["table"] = {
	columns: [
		{ key: "item", label: "Item" },
		{ key: "valor", label: "Valor", unit: "BRL" },
		{ key: "verdito", label: "Veredito" },
	],
	rows: [
		{ item: "Documento de requisitos do módulo", valor: 10, verdito: "Confirmado" },
		{ item: "Teste", valor: 7.5, verdito: "Parcial" },
		{ item: "Sem dado", valor: null, verdito: "Confirmado" },
	],
};

describe("tabela", () => {
	it("coluna Sim/Não não é pintada, Confirmado/Parcial é", () => {
		const view = tableView({ columns: [{ key: "q", label: "Possui filhos?" }, { key: "v", label: "Veredito" }], rows: [{ q: "Sim", v: "Confirmado" }, { q: "Não", v: "Parcial" }] });
		expect(view.rows.map((row) => row.map((cell) => cell.tone))).toEqual([[null, "positive"], [null, "warning"]]);
	});
	const view = tableView(table);
	it("células formatadas: número à direita com as mesmas casas, vazio como '—'", () => {
		expect(view.rows.map((row) => row.map((cell) => cell.text))).toEqual([
			["Documento de requisitos do módulo", "R$ 10,00", "Confirmado"],
			["Teste", "R$ 7,50", "Parcial"],
			["Sem dado", "—", "Confirmado"],
		]);
		expect(view.columns.map((column) => column.align)).toEqual(["left", "right", "left"]);
		expect(view.rows[0]![1]).toMatchObject({ numeric: true, align: "right" });
	});
	it("veredito vira tom só na coluna de status (nome nunca é pintado)", () => {
		expect(view.columns.map((column) => column.status)).toEqual([false, false, true]);
		expect(view.rows.map((row) => row[2]!.tone)).toEqual(["positive", "warning", "positive"]);
		expect(view.rows.map((row) => row[0]!.tone)).toEqual([null, null, null]);
	});
	it("o alinhamento do spec vale; compact e striped vêm da variante", () => {
		const aligned = tableView({ ...table, variant: "striped", columns: [{ key: "item", label: "Item", align: "center" }] });
		expect(aligned.columns[0]!.align).toBe("center");
		expect(aligned.striped).toBe(true);
		expect(tableView({ ...table, variant: "compact" }).compact).toBe(true);
	});
	it("larguras: texto curto não quebra e ganha o tamanho do maior valor; texto longo vai até o teto", () => {
		expect(tableColumnWidth("Valor", ["R$ 10,00", "R$ 7,50"])).toBe(92);
		expect(tableColumnWidth("Id", ["1"])).toBe(64);
		expect(tableColumnWidth("Item", ["Documento de requisitos do módulo"])).toBe(240);
		expect(tableColumnWidth("Item", ["Um texto de quinze+"])).toBeGreaterThanOrEqual(136);
		expect(view.columns[0]!.width).toBe(240);
	});
	it("a primeira coluna fica fixa só se há mais colunas e a tabela passa da tela", () => {
		expect(pinFirstColumn([200, 100, 100], 300)).toBe(true);
		expect(pinFirstColumn([100, 100], 300)).toBe(false);
		expect(pinFirstColumn([500], 300)).toBe(false);
		expect(pinFirstColumn([200, 200], 0)).toBe(false);
	});
	it("altura de linha sincronizada entre a coluna fixa e a rolável: só cresce", () => {
		let heights: readonly number[] = [];
		heights = mergeRowHeight(heights, 1, 30.2);
		expect(heights).toEqual([0, 31]);
		const same = mergeRowHeight(heights, 1, 20);
		expect(same).toBe(heights);
		expect(mergeRowHeight(heights, 1, 44)).toEqual([0, 44]);
		expect(mergeRowHeight(heights, 0, 12)).toEqual([12, 31]);
	});
});

describe("linha do tempo, kanban e lista", () => {
	it("linha do tempo: tom padrão é o destaque e o último item não liga linha", () => {
		const rows = timelineView({ items: [{ date: "01/10", title: "A" }, { date: "05/10", title: "B", text: "detalhe", tone: "critical" }] });
		expect(rows.map((row) => [row.tone, row.last])).toEqual([["accent", false], ["critical", true]]);
		expect(rows[1]!.text).toBe("detalhe");
		expect(rows[0]).not.toHaveProperty("text");
	});
	it("kanban: contagem por coluna", () => {
		const view = kanbanView({ columns: [{ title: "A fazer", items: [{ title: "x" }, { title: "y" }] }, { title: "Feito", items: [] }] });
		expect(view.map((column) => [column.title, column.count])).toEqual([["A fazer", 2], ["Feito", 0]]);
	});
	it("lista: valor formatado com as mesmas casas, texto como veio, sem valor = null", () => {
		const rows = listView({ items: [{ title: "A", value: 10, tone: "positive" }, { title: "B", value: 5.5, subtitle: "sub" }, { title: "C" }, { title: "D", value: "alto" }], unit: "BRL" });
		expect(rows.map((row) => row.valueText)).toEqual(["R$ 10,00", "R$ 5,50", null, "alto"]);
		expect(rows[0]!.tone).toBe("positive");
		expect(rows[1]!.subtitle).toBe("sub");
		expect(rows[2]!.tone).toBeNull();
	});
});

describe("título", () => {
	it("níveis: 2 é o padrão; 3 é rótulo pequeno em caixa alta e cinza", () => {
		expect(headingStyle(undefined)).toEqual(headingStyle(2));
		expect(headingStyle(1).size).toBeGreaterThan(headingStyle(2).size);
		expect(headingStyle(3)).toMatchObject({ uppercase: true, muted: true });
		expect(headingStyle(2)).toMatchObject({ uppercase: false, muted: false });
	});
});
