import { parseChartSpec, type ChartSpec } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHART_COLORS } from "./chart-palette";
import {
	buildBarRows,
	buildChartRows,
	buildForecast,
	chartExtent,
	chartValueFormatter,
	chartXLabels,
	describeReference,
	funnelGeometry,
	gaugeNotches,
	gaugeRatio,
	gaugeText,
	labelBudget,
	nearestIndex,
	niceScale,
	pickTickValues,
	pieCenterText,
	pieSliceAt,
	pressContent,
	pieShowsPercent,
	pieSlices,
	pressRows,
	radarGeometry,
	shouldUseHorizontalBars,
	sliceColor,
	xLabelSlot,
} from "./chart-data";

function spec(raw: Record<string, unknown>): ChartSpec {
	const parsed = parseChartSpec(raw);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.spec;
}

const monthly = spec({
	type: "line",
	x: "mes",
	series: [{ key: "total", label: "Total" }],
	data: [
		{ mes: "2025-01-01", total: 100 },
		{ mes: "2025-02-01", total: 200 },
		{ mes: "2025-03-01", total: null },
		{ mes: "2025-04-01", total: 400 },
	],
	unit: "BRL",
});

describe("formatação dos valores do gráfico", () => {
	it("moeda: inteiro sem centavos, fração com 2 casas; compacto no eixo a partir de 10 mil", () => {
		const format = chartValueFormatter({ unit: "BRL" });
		expect(format(28400)).toBe("R$ 28.400");
		expect(format(12.5)).toBe("R$ 12,50");
		const axis = chartValueFormatter({ unit: "BRL" }, { axis: true, max: 60000 });
		expect(axis(60000)).toBe("R$ 60 mil");
		expect(chartValueFormatter({ unit: "BRL" }, { axis: true, max: 900 })(500)).toBe("R$ 500");
	});
	it("percentual, unidade livre e número puro", () => {
		expect(chartValueFormatter({ unit: "%" })(12.5)).toBe("12,5%");
		expect(chartValueFormatter({ format: "percent" })(8)).toBe("8%");
		expect(chartValueFormatter({ unit: "kg" })(1234.5)).toBe("1.234,5 kg");
		expect(chartValueFormatter({})(1234.567)).toBe("1.234,57");
		expect(chartValueFormatter({ format: "compact" })(1_500_000)).toBe("1,5 mi");
	});
});

describe("rótulos do eixo X", () => {
	it("categorias vão como vieram", () => {
		const labels = chartXLabels(spec({ type: "bar", x: "regiao", series: ["v"], data: [{ regiao: "Sul", v: 1 }, { regiao: "Norte", v: 2 }] }));
		expect(labels.axis("Sul")).toBe("Sul");
		expect(labels.title("Norte")).toBe("Norte");
	});
	it("datas mensais: 'jan/25' no eixo e 'janeiro de 2025' no título", () => {
		const labels = chartXLabels(monthly);
		expect(labels.monthly).toBe(true);
		expect(labels.axis("2025-02-01")).toBe("fev/25");
		expect(labels.title("2025-03-01")).toBe("março de 2025");
	});
	it("datas diárias: dd/mm (com ano só se passar de um ano) e título dd/mm/aaaa", () => {
		const daily = spec({ type: "line", x: "d", series: ["v"], data: [{ d: "2025-10-05", v: 1 }, { d: "2025-10-12", v: 2 }] });
		const labels = chartXLabels(daily);
		expect(labels.axis("2025-10-05")).toBe("05/10");
		expect(labels.title("2025-10-12")).toBe("12/10/2025");
		const long = spec({ type: "line", x: "d", series: ["v"], data: [{ d: "2024-01-05", v: 1 }, { d: "2025-10-12", v: 2 }] });
		expect(chartXLabels(long).axis("2025-10-12")).toBe("12/10/25");
	});
});

describe("linhas do gráfico de linha/área/composto", () => {
	it("datas viram instantes UTC e buracos são interpolados", () => {
		const { rows, actual } = buildChartRows(monthly);
		expect(actual).toBe(4);
		expect(rows[0]!.x).toBe(Date.UTC(2025, 0, 1));
		expect(rows.map((row) => row.s0)).toEqual([100, 200, 300, 400]);
	});
	it("o valor original (com buraco) fica guardado para o toque", () => {
		expect(buildChartRows(monthly).original.map((values) => values[0])).toEqual([100, 200, null, 400]);
	});
	it("categorias viram posição 0..n-1 e o rótulo vem do spec", () => {
		const { rows, labelOf } = buildChartRows(spec({ type: "line", x: "r", series: ["v"], data: [{ r: "A", v: 1 }, { r: "B", v: 2 }] }));
		expect(rows.map((row) => row.x)).toEqual([0, 1]);
		expect(labelOf(1)).toBe("B");
	});
	it("no composto a barra com buraco fica sem valor (não interpola) e a linha interpola", () => {
		const composed = spec({
			type: "composed",
			x: "d",
			series: [{ key: "a", label: "A", kind: "bar" }, { key: "b", label: "B", kind: "line" }],
			data: [{ d: "2025-01-01", a: 1, b: 1 }, { d: "2025-02-01", a: null, b: null }, { d: "2025-03-01", a: 3, b: 3 }],
		});
		const { rows } = buildChartRows(composed);
		expect(rows.map((row) => row.s0)).toEqual([1, null, 3]);
		expect(rows.map((row) => row.s1)).toEqual([1, 2, 3]);
	});
	it("previsão: regressão linear, períodos mensais à frente, ligada ao último ponto real", () => {
		const withForecast = spec({
			type: "line",
			x: "mes",
			series: ["v"],
			data: [{ mes: "2025-01-01", v: 10 }, { mes: "2025-02-01", v: 20 }, { mes: "2025-03-01", v: 30 }],
			forecast: { points: 2 },
		});
		const { rows, actual, titleOf } = buildChartRows(withForecast);
		expect(actual).toBe(3);
		expect(rows).toHaveLength(5);
		expect(rows[2]!.f).toBe(30);
		expect(rows[3]!.x).toBe(Date.UTC(2025, 3, 1));
		expect(rows[3]!.f).toBeGreaterThan(36);
		expect(rows[3]!.s0).toBeNull();
		expect(titleOf(rows[4]!.x)).toBe("mai/25");
	});
	it("a previsão pura: passo pela mediana dos intervalos, sem dados suficientes não projeta", () => {
		const day = 86_400_000;
		const out = buildForecast([0, day, 2 * day], [1, 2, 3], 2, false);
		expect(out.xs).toEqual([3 * day, 4 * day]);
		expect(out.ys[0]).toBeCloseTo(4, 6);
		expect(buildForecast([0], [1], 3, false)).toEqual({ xs: [], ys: [] });
		expect(buildForecast([0, 1], [1, 2], 0, false)).toEqual({ xs: [], ys: [] });
	});
	it("faixa de referência e previsão entram no extremo do eixo", () => {
		const base = spec({ type: "line", x: "r", series: ["v"], data: [{ r: "A", v: 10 }, { r: "B", v: 20 }], reference: { from: 50, label: "Meta" } });
		// linha pura não é ancorada no zero: a faixa vai do menor valor (ou da meta) ao maior
		expect(chartExtent(base, buildChartRows(base).rows)).toEqual({ min: 10, max: 50 });
		const area = spec({ type: "area", x: "r", series: ["v"], data: [{ r: "A", v: 10 }, { r: "B", v: 20 }] });
		expect(chartExtent(area, buildChartRows(area).rows)).toEqual({ min: 0, max: 20 });
	});
	it("empilhado soma por linha", () => {
		const stacked = spec({ type: "area", x: "r", series: ["a", "b"], data: [{ r: "A", a: 10, b: 5 }, { r: "B", a: 1, b: 1 }], stacked: true });
		expect(chartExtent(stacked, buildChartRows(stacked).rows).max).toBe(15);
	});
	it("texto da meta: faixa, a partir de e até", () => {
		expect(describeReference(spec({ type: "line", x: "r", series: ["v"], data: [{ r: "A", v: 1 }], reference: { from: 5000, label: "Meta" }, unit: "BRL" }))).toBe("Meta (a partir de R$ 5.000)");
		expect(describeReference(spec({ type: "line", x: "r", series: ["v"], data: [{ r: "A", v: 1 }], reference: { from: 1, to: 3 } }))).toBe("1 – 3");
		expect(describeReference(spec({ type: "line", x: "r", series: ["v"], data: [{ r: "A", v: 1 }], reference: { to: 3 } }))).toBe("até 3");
		expect(describeReference(monthly)).toBeNull();
	});
});

describe("escala e rótulos", () => {
	it("escala bonita cobre os dados com marcas redondas", () => {
		expect(niceScale(0, 87, 4)).toEqual({ min: 0, max: 100, ticks: [0, 20, 40, 60, 80, 100] });
		expect(niceScale(0, 1200, 4).max).toBe(1200);
		expect(niceScale(5, 5).ticks.length).toBeGreaterThan(1);
		expect(niceScale(Number.NaN, 3).ticks).toEqual([0, 1]);
		expect(niceScale(-10, 10, 4).ticks).toContain(0);
	});
	it("escolhe rótulos espalhados, sempre com o primeiro e o último", () => {
		expect(pickTickValues([1, 2, 3], 5)).toEqual([1, 2, 3]);
		const picked = pickTickValues(Array.from({ length: 10 }, (_, i) => i), 4);
		expect(picked[0]).toBe(0);
		expect(picked.at(-1)).toBe(9);
		expect(picked).toHaveLength(4);
		expect(pickTickValues([1, 2, 3], 1)).toEqual([1]);
	});
	it("orçamento de rótulos e largura por rótulo", () => {
		expect(labelBudget(300, 74)).toBe(4);
		expect(labelBudget(20, 74)).toBe(2);
		expect(xLabelSlot(["jan/25"])).toBe(58);
		expect(xLabelSlot(["x"])).toBe(48);
		expect(xLabelSlot(["um nome bem comprido de categoria"])).toBe(110);
	});
	it("barras deitam só com nomes longos e muitos", () => {
		expect(shouldUseHorizontalBars(["A", "B", "C"], 300)).toBe(false);
		expect(shouldUseHorizontalBars(["Região metropolitana", "Interior do estado", "Litoral norte", "Litoral sul"], 200)).toBe(true);
		expect(shouldUseHorizontalBars(["Sul", "Norte", "Leste", "Oeste", "Centro", "Total", "Outro"], 200)).toBe(false);
	});
	it("o ponto real mais próximo do toque", () => {
		expect(nearestIndex([0, 10, 20], 12)).toBe(1);
		expect(nearestIndex([], 3)).toBeNull();
	});
});

describe("barras", () => {
	const bars = spec({ type: "bar", x: "r", series: [{ key: "a", label: "A" }, { key: "b", label: "B" }], data: [{ r: "Sul", a: 3, b: null }, { r: "Norte", a: 5, b: 2 }], stacked: true });
	it("valor ausente vira 0, posição 0..n-1 e rótulos do eixo", () => {
		const { rows, labels } = buildBarRows(bars);
		expect(rows.map((row) => [row.x, row.s0, row.s1])).toEqual([[0, 3, 0], [1, 5, 2]]);
		expect(labels).toEqual(["Sul", "Norte"]);
	});
});

describe("rosca", () => {
	const pie = spec({ type: "pie", x: "s", series: [{ key: "n", label: "Correções" }], data: [{ s: "Feitas", n: 3 }, { s: "Não feitas", n: 3 }, { s: "Zero", n: 0 }] });
	it("só fatias positivas, com porcentagem e valor formatados", () => {
		const slices = pieSlices(pie, DEFAULT_CHART_COLORS.dark, "#09090b");
		expect(slices.map((slice) => [slice.label, slice.percentText, slice.valueText])).toEqual([["Feitas", "50%", "3"], ["Não feitas", "50%", "3"]]);
		expect(slices[0]!.color).toBe(DEFAULT_CHART_COLORS.dark.series[0]);
		expect(slices[1]!.color).toBe(DEFAULT_CHART_COLORS.dark.series[1]);
	});
	it("fração de porcentagem com uma casa, e a 7ª fatia usa a cor misturada ao fundo", () => {
		const many = spec({ type: "pie", x: "s", series: ["n"], data: ["a", "b", "c", "d", "e", "f", "g"].map((s, i) => ({ s, n: i === 0 ? 1 : 1 })) });
		const slices = pieSlices(many, DEFAULT_CHART_COLORS.dark, "#09090b");
		expect(slices[0]!.percentText).toBe("14,3%");
		expect(slices[6]!.color).not.toBe(slices[0]!.color);
		expect(sliceColor(DEFAULT_CHART_COLORS.dark, 2, "#09090b")).toBe(DEFAULT_CHART_COLORS.dark.series[2]);
	});
	it("miolo: o total, ou a fatia tocada; total comprido usa a forma compacta", () => {
		const slices = pieSlices(pie, DEFAULT_CHART_COLORS.dark, "#09090b");
		expect(pieCenterText(pie, slices, null)).toEqual({ value: "6", label: "Correções" });
		expect(pieCenterText(pie, slices, 1)).toEqual({ value: "3", label: "Não feitas" });
		const big = spec({ type: "pie", x: "s", series: ["n"], data: [{ s: "A", n: 4905000 }, { s: "B", n: 1 }], unit: "BRL" });
		expect(pieCenterText(big, pieSlices(big, DEFAULT_CHART_COLORS.dark, "#000000"), null).value).toBe("R$ 4,9 mi");
	});
	it("a legenda esconde a porcentagem quando o valor já é uma porcentagem", () => {
		expect(pieShowsPercent({})).toBe(true);
		expect(pieShowsPercent({ unit: "%" })).toBe(false);
		expect(pieShowsPercent({ format: "percent" })).toBe(false);
	});
});

describe("radar", () => {
	const radar = spec({ type: "radar", x: "eixo", series: [{ key: "a", label: "A" }], data: [{ eixo: "X", a: 10 }, { eixo: "Y", a: 5 }, { eixo: "Z", a: 0 }] });
	it("escala relativa ao maior valor; o primeiro eixo aponta para cima", () => {
		const geometry = radarGeometry(radar, 300, 50);
		expect(geometry.peak).toBe(10);
		expect(geometry.axes).toHaveLength(3);
		expect(geometry.axes[0]!.x).toBeCloseTo(150, 6);
		expect(geometry.axes[0]!.y).toBeCloseTo(50, 6);
		expect(geometry.grid).toHaveLength(4);
		// valor 10 (o maior) = ponta do eixo; valor 0 = centro
		expect(geometry.areas[0]![0]!.y).toBeCloseTo(50, 6);
		expect(geometry.areas[0]![2]!.x).toBeCloseTo(150, 6);
		expect(geometry.areas[0]![2]!.y).toBeCloseTo(150, 6);
		expect(geometry.labels.map((label) => label.text)).toEqual(["X", "Y", "Z"]);
	});
});

describe("funil", () => {
	const funnel = spec({ type: "funnel", x: "etapa", series: [{ key: "n", label: "Leads" }], data: [{ etapa: "Visitas", n: 1000 }, { etapa: "Leads", n: 500 }, { etapa: "Vendas", n: 100 }] });
	it("a primeira etapa é 100% da largura e as outras seguem o valor", () => {
		const stages = funnelGeometry(funnel, 300, 40);
		expect(stages.map((stage) => stage.percentText)).toEqual(["100%", "50%", "10%"]);
		expect(stages.map((stage) => stage.topWidth)).toEqual([300, 150, 30]);
		expect(stages[0]!.bottomWidth).toBe(150);
		expect(stages[2]!.bottomWidth).toBe(30);
		expect(stages[1]!.top).toBe(46);
		expect(stages[0]!.valueText).toBe("1.000");
		expect(stages[2]!.opacity).toBeLessThan(stages[0]!.opacity);
	});
});

describe("medidor", () => {
	const gauge = spec({ type: "gauge", x: "m", series: [{ key: "v", label: "Meta" }], data: [{ m: "x", v: 62 }], unit: "%" });
	it("razão valor/max (padrão 100), texto no formato e entalhes preenchidos", () => {
		expect(gaugeRatio(gauge)).toBe(0.62);
		expect(gaugeText(gauge)).toBe("62%");
		const notches = gaugeNotches(0.62);
		expect(notches).toHaveLength(40);
		expect(notches.filter((notch) => notch.active)).toHaveLength(25);
		expect(notches[0]!.angle).toBeCloseTo(135 + 3.375, 6);
		expect(gaugeRatio(spec({ type: "gauge", x: "m", series: ["v"], data: [{ m: "x", v: 30 }], max: 60 }))).toBe(0.5);
	});
});

describe("toque", () => {
	it("uma linha por série com cor, rótulo e valor ('—' sem dado)", () => {
		const two = spec({ type: "line", x: "r", series: [{ key: "a", label: "A" }, { key: "b", label: "B" }], data: [{ r: "X", a: 1, b: null }, { r: "Y", a: 2, b: 3 }] });
		const rows = pressRows(two, DEFAULT_CHART_COLORS.dark, [1, null]);
		expect(rows).toEqual([{ color: DEFAULT_CHART_COLORS.dark.series[0], label: "A", value: "1" }, { color: DEFAULT_CHART_COLORS.dark.series[1], label: "B", value: "—" }]);
	});
});

describe("conteúdo ao tocar no gráfico", () => {
	it("ponto real: título da data e o valor original da série", () => {
		const model = buildChartRows(monthly);
		const content = pressContent(monthly, DEFAULT_CHART_COLORS.dark, model, 1)!;
		expect(content.title).toBe("fevereiro de 2025");
		expect(content.rows).toEqual([{ color: DEFAULT_CHART_COLORS.dark.series[0], label: "Total", value: "R$ 200" }]);
		// o buraco mostra "—" (não o valor interpolado do traço)
		expect(pressContent(monthly, DEFAULT_CHART_COLORS.dark, model, 2)!.rows[0]!.value).toBe("—");
	});
	it("período projetado mostra só a previsão; fora da faixa não mostra nada", () => {
		const forecast = spec({ type: "line", x: "mes", series: ["v"], data: [{ mes: "2025-01-01", v: 10 }, { mes: "2025-02-01", v: 20 }, { mes: "2025-03-01", v: 30 }], forecast: { points: 1 } });
		const model = buildChartRows(forecast);
		const content = pressContent(forecast, DEFAULT_CHART_COLORS.dark, model, 3)!;
		expect(content.title).toBe("abr/25");
		expect(content.rows[0]!.label).toBe("Previsão");
		expect(pressContent(forecast, DEFAULT_CHART_COLORS.dark, model, 9)).toBeNull();
	});
});

describe("fatia sob o dedo", () => {
	// duas fatias iguais, começando às 3 horas e indo no sentido horário: a de baixo (0° a 180°) e a de cima
	it("acha a fatia pelo ângulo e ignora fora do anel", () => {
		expect(pieSliceAt([1, 1], 0, 80, 0, 64, 100)).toBe(0);
		expect(pieSliceAt([1, 1], 0, -80, 0, 64, 100)).toBe(1);
		expect(pieSliceAt([1, 1], 0, 0, 0, 64, 100)).toBeNull();
		expect(pieSliceAt([1, 1], 0, 150, 0, 64, 100)).toBeNull();
		expect(pieSliceAt([], 0, 80, 0, 64, 100)).toBeNull();
	});
	it("respeita o ângulo inicial (-90 = começa no topo)", () => {
		expect(pieSliceAt([1, 1], 80, 0, -90, 64, 100)).toBe(0);
		expect(pieSliceAt([1, 1], -80, 0, -90, 64, 100)).toBe(1);
	});
});
