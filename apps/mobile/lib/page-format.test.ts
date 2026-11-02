import { describe, expect, it } from "vitest";
import type { ChartSpec } from "@workspace/shared";
import { barPercent, chartTable, currencyDigits, formatCompact, formatDecimal, formatPageDelta, formatPageNumber, formatPageValue, resolveTab, shortDeltaLabel, sourceCountLabel, updatedAgoLabel } from "./page-format";

describe("números do painel (sem Intl)", () => {
	it("decimal pt-BR: milhar com ponto, vírgula, sem zeros sobrando", () => {
		expect(formatDecimal(1234.5, 0, 2)).toBe("1.234,5");
		expect(formatDecimal(1234567.891, 0, 2)).toBe("1.234.567,89");
		expect(formatDecimal(12, 0, 2)).toBe("12");
		expect(formatDecimal(12, 2, 2)).toBe("12,00");
		expect(formatDecimal(-1500, 0, 2)).toBe("-1.500");
		expect(formatDecimal(-0.001, 0, 2)).toBe("0");
		expect(formatDecimal(0, 0, 2)).toBe("0");
		expect(formatDecimal(Number.NaN, 0, 2)).toBe("—");
		expect(formatDecimal(1e22, 0, 2)).toBe("1e+22");
	});
	it("compacto: mil, mi, bi, tri e arredondamento que sobe de faixa", () => {
		expect(formatCompact(999)).toBe("999");
		expect(formatCompact(12.34)).toBe("12,3");
		expect(formatCompact(1000)).toBe("1 mil");
		expect(formatCompact(1234)).toBe("1,2 mil");
		expect(formatCompact(45_600)).toBe("45,6 mil");
		expect(formatCompact(1_500_000)).toBe("1,5 mi");
		expect(formatCompact(999_960)).toBe("1 mi");
		expect(formatCompact(2_300_000_000)).toBe("2,3 bi");
		expect(formatCompact(4e12)).toBe("4 tri");
		expect(formatCompact(-2500)).toBe("-2,5 mil");
		expect(formatCompact(Number.POSITIVE_INFINITY)).toBe("—");
	});
	it("moeda: reais inteiros se o grupo é inteiro, centavos se não; BRL por padrão no formato currency", () => {
		expect(formatPageNumber(120000, { unit: "BRL" })).toBe("R$ 120.000");
		expect(formatPageNumber(1234.5, { unit: "BRL" })).toBe("R$ 1.234,50");
		expect(formatPageNumber(1000, { unit: "BRL", digits: 2 })).toBe("R$ 1.000,00");
		expect(formatPageNumber(1500, { format: "currency" })).toBe("R$ 1.500");
		expect(formatPageNumber(99, { unit: "usd" })).toBe("US$ 99");
		expect(formatPageNumber(10, { unit: "EUR" })).toBe("€ 10");
		expect(formatPageNumber(-300, { unit: "BRL" })).toBe("-R$ 300");
		expect(formatPageNumber(1_200_000, { unit: "BRL", format: "compact" })).toBe("R$ 1,2 mi");
		expect(currencyDigits([1, 2, 3])).toBe(0);
		expect(currencyDigits([1, 2.5, null])).toBe(2);
	});
	it("percentual, unidade livre e compacto simples", () => {
		expect(formatPageNumber(12.345, { format: "percent" })).toBe("12,35%");
		expect(formatPageNumber(8, { unit: "%" })).toBe("8%");
		expect(formatPageNumber(42, { unit: "kg" })).toBe("42 kg");
		expect(formatPageNumber(2500, { format: "compact" })).toBe("2,5 mil");
		expect(formatPageNumber(Number.NaN)).toBe("—");
	});
	it("valor de célula: texto como veio, vazio vira traço", () => {
		expect(formatPageValue("Pago")).toBe("Pago");
		expect(formatPageValue(null)).toBe("—");
		expect(formatPageValue("")).toBe("—");
		expect(formatPageValue(undefined)).toBe("—");
		expect(formatPageValue(3.5, { unit: "x" })).toBe("3,5 x");
	});
});

describe("variação, barras e abas", () => {
	it("variação leva seta e sinal; estável vira traço", () => {
		expect(formatPageDelta({ value: 8, direction: "up", kind: "percent", label: "vs meta" })).toBe("▲ 8% vs meta");
		expect(formatPageDelta({ value: -300, direction: "down", kind: "absolute" }, { unit: "BRL" })).toBe("▼ R$ 300");
		expect(formatPageDelta({ value: "+2 pedidos", direction: "up" })).toBe("▲ +2 pedidos");
		expect(formatPageDelta({ value: 0, direction: "flat", label: "vs. semana anterior" })).toBe("— vs. sem. ant.");
		expect(formatPageDelta({ value: 0, direction: "flat" })).toBe("—");
	});
	it("rótulos longos de variação encurtam", () => {
		expect(shortDeltaLabel("vs. mês anterior")).toBe("vs. mês ant.");
		expect(shortDeltaLabel("Em relação à meta")).toBe("vs. meta");
		expect(shortDeltaLabel("  qualquer coisa ")).toBe("qualquer coisa");
	});
	it("largura da barra: relativa ao maior, nunca negativa nem acima de 100", () => {
		expect(barPercent(50, 100)).toBe(50);
		expect(barPercent(33.33, 100)).toBe(33.3);
		expect(barPercent(200, 100)).toBe(100);
		expect(barPercent(-5, 100)).toBe(0);
		expect(barPercent(5, 0)).toBe(0);
		expect(barPercent(0, 10)).toBe(0);
	});
	it("resolveTab: a pedida se existir, senão a primeira", () => {
		const tabs = [{ id: "a" }, { id: "b" }];
		expect(resolveTab(tabs, "b").id).toBe("b");
		expect(resolveTab(tabs, "zzz").id).toBe("a");
		expect(resolveTab(tabs, null).id).toBe("a");
		expect(resolveTab(tabs, undefined).id).toBe("a");
	});
	it("fontes no plural", () => {
		expect(sourceCountLabel(0)).toBeNull();
		expect(sourceCountLabel(1)).toBe("1 fonte");
		expect(sourceCountLabel(3)).toBe("3 fontes");
	});
});

describe("Atualizado há…", () => {
	const now = Date.parse("2026-11-02T12:00:00Z");
	it("agora, minutos, horas, dias e data", () => {
		expect(updatedAgoLabel("2026-11-02T11:59:40Z", now)).toBe("Atualizado agora");
		expect(updatedAgoLabel("2026-11-02T11:55:00Z", now)).toBe("Atualizado há 5 min");
		expect(updatedAgoLabel("2026-11-02T10:00:00Z", now)).toBe("Atualizado há 2 h");
		expect(updatedAgoLabel("2026-11-01T11:00:00Z", now)).toBe("Atualizado há 1 dia");
		expect(updatedAgoLabel("2026-10-28T12:00:00Z", now)).toBe("Atualizado há 5 dias");
		expect(updatedAgoLabel("2026-08-01T12:00:00Z", now)).toBe("Atualizado em 01/08/2026");
	});
	it("data ausente ou inválida: nada; relógio adiantado: agora", () => {
		expect(updatedAgoLabel(null, now)).toBeNull();
		expect(updatedAgoLabel("ontem", now)).toBeNull();
		expect(updatedAgoLabel("2026-11-02T12:05:00Z", now)).toBe("Atualizado agora");
	});
});

describe("gráfico como tabela provisória", () => {
	const spec = (extra: Partial<ChartSpec> = {}): ChartSpec => ({
		type: "line",
		title: "Receita",
		x: "mes",
		series: [{ key: "v", label: "Valor" }],
		data: [{ mes: "Jan", v: 1500 }, { mes: "Fev", v: null }],
		unit: "BRL",
		xKind: "category",
		...extra,
	});
	it("cabeçalho do eixo e das séries, valores formatados, vazio como traço", () => {
		expect(chartTable(spec())).toEqual({ title: "Receita", header: ["mes", "Valor"], rows: [["Jan", "R$ 1.500"], ["Fev", "—"]], hidden: 0 });
	});
	it("limita as linhas e diz quantas ficaram de fora", () => {
		const data = Array.from({ length: 30 }, (_, i) => ({ mes: `m${i}`, v: i }));
		const table = chartTable(spec({ data, unit: undefined }));
		expect(table?.rows).toHaveLength(12);
		expect(table?.hidden).toBe(18);
	});
	it("sem dados ou sem série não vira tabela; título ausente = Gráfico", () => {
		expect(chartTable(spec({ data: [] }))).toBeNull();
		expect(chartTable(spec({ series: [] }))).toBeNull();
		expect(chartTable(spec({ title: undefined }))?.title).toBe("Gráfico");
	});
});
