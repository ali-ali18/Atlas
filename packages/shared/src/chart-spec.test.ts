import { describe, expect, it } from "vitest";
import { CHART_MAX_POINTS, CHART_MAX_SERIES, chartSpecToCsv, parseChartSpec, summarizeChartSpec } from "./chart-spec.js";
import { parseConversationCard } from "./skill-card.js";

const base = {
	type: "line",
	title: "Vendas",
	x: "mes",
	series: [{ key: "total", label: "Total" }],
	data: [
		{ mes: "2025-01-01", total: 1200.5 },
		{ mes: "2025-02-01", total: 900 },
	],
	unit: "brl",
};

describe("parseChartSpec: orientation e campos desconhecidos", () => {
	const bar = { ...base, type: "bar", x: "mes" };

	it("orientation horizontal passa em bar e vem no spec; ausente fica ausente", () => {
		const parsed = parseChartSpec({ ...bar, orientation: "horizontal" });
		expect(parsed.ok && parsed.spec.orientation).toBe("horizontal");
		const auto = parseChartSpec(bar);
		expect(auto.ok && "orientation" in auto.spec).toBe(false);
	});

	it("orientation inválida ou fora de bar falha com mensagem para o modelo", () => {
		const invalid = parseChartSpec({ ...bar, orientation: "diagonal" });
		expect(invalid.ok ? "" : invalid.error).toMatch(/orientation must be one of: vertical, horizontal/);
		const wrongType = parseChartSpec({ ...base, orientation: "horizontal" });
		expect(wrongType.ok ? "" : wrongType.error).toMatch(/only used with type "bar"/);
	});

});

describe("parseChartSpec", () => {
	it("aceita o spec válido, normaliza a moeda e detecta datas", () => {
		const parsed = parseChartSpec(base);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.spec.unit).toBe("BRL");
			expect(parsed.spec.xKind).toBe("date");
			expect(parsed.spec.series).toEqual([{ key: "total", label: "Total" }]);
		}
	});

	it("aceita o JSON como texto e rejeita texto incompleto (streaming)", () => {
		expect(parseChartSpec(JSON.stringify(base)).ok).toBe(true);
		const partial = parseChartSpec(JSON.stringify(base).slice(0, 60));
		expect(partial).toEqual({ ok: false, error: "chart spec is not valid JSON" });
	});

	it("categorias de texto ficam como category e séries sem rótulo usam a chave", () => {
		const parsed = parseChartSpec({ type: "bar", x: "loja", series: ["vendas"], data: [{ loja: "Centro", vendas: 3 }, { loja: "Norte", vendas: null }] });
		expect(parsed.ok && parsed.spec.xKind).toBe("category");
		expect(parsed.ok && parsed.spec.series[0]!.label).toBe("vendas");
	});

	it("rejeita tipo, campos e valores inválidos", () => {
		expect(parseChartSpec({ ...base, type: "radar" }).ok).toBe(false);
		expect(parseChartSpec({ ...base, x: "" }).ok).toBe(false);
		expect(parseChartSpec({ ...base, series: [] }).ok).toBe(false);
		expect(parseChartSpec({ ...base, data: [] }).ok).toBe(false);
		expect(parseChartSpec({ ...base, data: [{ mes: "a", total: "12" }] }).ok).toBe(false);
		expect(parseChartSpec({ ...base, series: [{ key: "mes" }] }).ok).toBe(false);
		expect(parseChartSpec({ ...base, data: [{ mes: "a", total: null }] }).ok).toBe(false);
	});

	it("respeita os limites de pontos e séries", () => {
		const many = Array.from({ length: CHART_MAX_POINTS + 1 }, (_, index) => ({ mes: `m${index}`, total: index }));
		expect(parseChartSpec({ ...base, data: many }).ok).toBe(false);
		const series = Array.from({ length: CHART_MAX_SERIES + 1 }, (_, index) => ({ key: `s${index}` }));
		expect(parseChartSpec({ ...base, series }).ok).toBe(false);
		const ok = Array.from({ length: CHART_MAX_POINTS }, (_, index) => ({ mes: `m${index}`, total: index }));
		expect(parseChartSpec({ ...base, data: ok }).ok).toBe(true);
	});

	it("pizza: usa só a primeira série, não aceita negativo e limita as fatias", () => {
		const pie = { type: "pie", x: "canal", series: [{ key: "v" }, { key: "w" }], data: [{ canal: "A", v: 1, w: 2 }, { canal: "B", v: 3, w: 4 }] };
		const parsed = parseChartSpec(pie);
		expect(parsed.ok && parsed.spec.series).toHaveLength(1);
		expect(parseChartSpec({ ...pie, data: [{ canal: "A", v: -1 }] }).ok).toBe(false);
		expect(parseChartSpec({ ...pie, data: Array.from({ length: 13 }, (_, index) => ({ canal: `c${index}`, v: 1 })) }).ok).toBe(false);
	});
});

describe("resumo e CSV", () => {
	it("resume o spec para o modelo", () => {
		const parsed = parseChartSpec(base);
		expect(parsed.ok && summarizeChartSpec(parsed.spec, "vendas.chart.json")).toBe(
			'vendas.chart.json: line chart "Vendas", 2 points (2025-01-01 to 2025-02-01), series: Total, unit BRL',
		);
	});

	it("gera CSV pt-BR e neutraliza fórmulas", () => {
		const parsed = parseChartSpec({ type: "bar", x: "nome", series: [{ key: "v", label: "Valor" }], data: [{ nome: "=SOMA(A1)", v: 1.5 }, { nome: "a;b", v: null }] });
		expect(parsed.ok && chartSpecToCsv(parsed.spec)).toBe("nome;Valor\n\"'=SOMA(A1)\";1,5\n\"a;b\";");
	});
});

describe("cartões persistidos", () => {
	it("code-run: trunca código e saída e exige callId e código", () => {
		const card = parseConversationCard(JSON.stringify({ v: 1, kind: "code-run", callId: "c1", code: "x".repeat(25_000), output: "y".repeat(9_000), status: "error", durationMs: 1234.4 }));
		expect(card?.kind === "code-run" && card.code.length).toBe(20_000);
		expect(card?.kind === "code-run" && card.output?.length).toBe(4_000);
		expect(card?.kind === "code-run" && card.durationMs).toBe(1234);
		expect(parseConversationCard(JSON.stringify({ v: 1, kind: "code-run", callId: "c1", code: " " }))).toBeNull();
	});

	it("chart: revalida o spec ao ler", () => {
		const parsed = parseChartSpec(base);
		const raw = { v: 1, kind: "chart", chartId: "c1:vendas.chart.json", spec: parsed.ok ? parsed.spec : null };
		expect(parseConversationCard(JSON.stringify(raw))?.kind).toBe("chart");
		expect(parseConversationCard(JSON.stringify({ ...raw, spec: { type: "line" } }))).toBeNull();
	});
});

describe("paleta", () => {
	it("sem paleta mantém o visual padrão (campos ausentes)", () => {
		const parsed = parseChartSpec(base);
		expect(parsed.ok && "palette" in parsed.spec).toBe(false);
		expect(parsed.ok && "colors" in parsed.spec).toBe(false);
	});

	it("aceita paletas prontas e descarta colors fora de custom", () => {
		const parsed = parseChartSpec({ ...base, palette: "ocean", colors: ["#fff"] });
		expect(parsed.ok && parsed.spec.palette).toBe("ocean");
		expect(parsed.ok && parsed.spec.colors).toBeUndefined();
	});

	it("custom normaliza hex (#abc → #aabbcc, minúsculas)", () => {
		const parsed = parseChartSpec({ ...base, palette: "custom", colors: ["#ABC", " #2563EB "] });
		expect(parsed.ok && parsed.spec.colors).toEqual(["#aabbcc", "#2563eb"]);
	});

	it("colors sozinho implica custom", () => {
		const parsed = parseChartSpec({ ...base, colors: ["#2563eb"] });
		expect(parsed.ok && parsed.spec.palette).toBe("custom");
	});

	it("rejeita paleta desconhecida, custom sem cores, cor inválida e excesso de cores", () => {
		const error = (extra: Record<string, unknown>) => {
			const parsed = parseChartSpec({ ...base, ...extra });
			return parsed.ok ? "" : parsed.error;
		};
		expect(error({ palette: "neon" })).toContain("palette must be one of");
		expect(error({ palette: "custom" })).toContain('needs colors');
		expect(error({ colors: ["red"] })).toContain("colors[0] must be a hex color");
		expect(error({ colors: ["#fff", "javascript:alert(1)"] })).toContain("colors[1]");
		expect(error({ colors: ["#111", "#222", "#333", "#444", "#555", "#666", "#777"] })).toContain("1 to 6");
		expect(error({ colors: [] })).toContain("1 to 6");
	});
});

describe("novos tipos", () => {
	const err = (raw: Record<string, unknown>) => {
		const parsed = parseChartSpec(raw);
		return parsed.ok ? "" : parsed.error;
	};
	const radarRows = [
		{ eixo: "Preço", a: 80, b: 60 },
		{ eixo: "Prazo", a: 70, b: 90 },
		{ eixo: "Qualidade", a: 90, b: 75 },
	];

	it("radar: 3 a 12 eixos, várias séries, sem negativos", () => {
		const ok = parseChartSpec({ type: "radar", x: "eixo", series: [{ key: "a" }, { key: "b" }], data: radarRows });
		expect(ok.ok && ok.spec.type).toBe("radar");
		expect(ok.ok && ok.spec.xKind).toBe("category");
		expect(err({ type: "radar", x: "eixo", series: [{ key: "a" }], data: radarRows.slice(0, 2) })).toContain("at least 3 axes");
		expect(err({ type: "radar", x: "eixo", series: [{ key: "a" }], data: Array.from({ length: 13 }, (_, i) => ({ eixo: `e${i}`, a: 1 })) })).toContain("too many axes");
		expect(err({ type: "radar", x: "eixo", series: [{ key: "a" }], data: [...radarRows.slice(0, 2), { eixo: "x", a: -1 }] })).toContain("cannot be negative");
	});

	it("funil: uma série, etapas limitadas, valor positivo", () => {
		const ok = parseChartSpec({ type: "funnel", x: "etapa", series: [{ key: "v" }, { key: "w" }], data: [{ etapa: "Leads", v: 100 }, { etapa: "Venda", v: 20 }] });
		expect(ok.ok && ok.spec.series).toHaveLength(1);
		expect(err({ type: "funnel", x: "etapa", series: [{ key: "v" }], data: Array.from({ length: 13 }, (_, i) => ({ etapa: `e${i}`, v: 1 })) })).toContain("too many stages");
		expect(err({ type: "funnel", x: "etapa", series: [{ key: "v" }], data: [{ etapa: "a", v: 0 }] })).toContain("at least one positive");
	});

	it("medidor: uma linha, max opcional e valor dentro da escala", () => {
		const ok = parseChartSpec({ type: "gauge", x: "m", series: [{ key: "v", label: "Meta atingida" }], data: [{ m: "Meta", v: 72 }], unit: "%" });
		expect(ok.ok && ok.spec.max).toBeUndefined();
		const withMax = parseChartSpec({ type: "gauge", x: "m", series: [{ key: "v" }], data: [{ m: "Meta", v: 420 }], max: 500 });
		expect(withMax.ok && withMax.spec.max).toBe(500);
		expect(err({ type: "gauge", x: "m", series: [{ key: "v" }], data: [{ m: "a", v: 1 }, { m: "b", v: 2 }] })).toContain("single value");
		expect(err({ type: "gauge", x: "m", series: [{ key: "v" }], data: [{ m: "a", v: 120 }] })).toContain("exceeds max");
		expect(err({ ...base, max: 10 })).toContain('only used with type "gauge"');
		expect(err({ type: "gauge", x: "m", series: [{ key: "v" }], data: [{ m: "a", v: 1 }], max: 0 })).toContain("positive number");
	});

	it("composto: datas obrigatórias e kind por série", () => {
		const data = [{ mes: "2025-01-01", r: 10, m: 5 }, { mes: "2025-02-01", r: 12, m: 6 }];
		const ok = parseChartSpec({ type: "composed", x: "mes", series: [{ key: "r", kind: "bar" }, { key: "m", kind: "line" }], data });
		expect(ok.ok && ok.spec.series.map((item) => item.kind)).toEqual(["bar", "line"]);
		expect(err({ type: "composed", x: "mes", series: [{ key: "r" }], data: [{ mes: "jan", r: 1 }] })).toContain("needs ISO dates");
		expect(err({ type: "composed", x: "mes", series: [{ key: "r", kind: "pizza" }], data })).toContain("kind must be one of");
		expect(err({ ...base, series: [{ key: "total", kind: "bar" }] })).toContain('only used with type "composed"');
	});
});

describe("meta e projeção", () => {
	const err = (extra: Record<string, unknown>, from: Record<string, unknown> = base) => {
		const parsed = parseChartSpec({ ...from, ...extra });
		return parsed.ok ? "" : parsed.error;
	};
	const trend = {
		type: "line",
		x: "mes",
		series: [{ key: "v" }],
		data: [{ mes: "2025-01-01", v: 1 }, { mes: "2025-02-01", v: 2 }, { mes: "2025-03-01", v: 3 }],
	};

	it("reference: faixa, meta com um limite só e rótulo", () => {
		const band = parseChartSpec({ ...base, reference: { from: 800, to: 1000, label: "Faixa ideal" } });
		expect(band.ok && band.spec.reference).toEqual({ from: 800, to: 1000, label: "Faixa ideal" });
		const target = parseChartSpec({ ...base, reference: { from: 5000 } });
		expect(target.ok && target.spec.reference).toEqual({ from: 5000 });
	});

	it("reference: valida limites e tipo de gráfico", () => {
		expect(err({ reference: {} })).toContain("needs from, to or both");
		expect(err({ reference: { from: "alto" } })).toContain("reference.from must be a number");
		expect(err({ reference: { from: 10, to: 5 } })).toContain("less than or equal");
		expect(err({ reference: { from: 1 } }, { type: "pie", x: "c", series: [{ key: "v" }], data: [{ c: "a", v: 1 }] })).toContain("only available for line, area, bar and composed");
	});

	it("forecast: só linha/área com datas, 3+ pontos e 1 a 24 períodos", () => {
		const ok = parseChartSpec({ ...trend, forecast: { points: 3 } });
		expect(ok.ok && ok.spec.forecast).toEqual({ points: 3 });
		expect(err({ forecast: { points: 3 } }, { ...trend, type: "bar" })).toContain("only available for line and area");
		expect(err({ forecast: { points: 0 } }, trend)).toContain("integer from 1 to 24");
		expect(err({ forecast: { points: 25 } }, trend)).toContain("integer from 1 to 24");
		expect(err({ forecast: { points: 2 } }, { ...trend, data: trend.data.slice(0, 2) })).toContain("at least 3 data points");
		expect(err({ forecast: { points: 2 } }, { ...trend, data: [{ mes: "a", v: 1 }, { mes: "b", v: 2 }, { mes: "c", v: 3 }] })).toContain("needs ISO dates");
	});

	it("specs antigos continuam válidos sem os novos campos", () => {
		const parsed = parseChartSpec(base);
		expect(parsed.ok && ["reference", "forecast", "max"].some((key) => key in parsed.spec)).toBe(false);
	});
});
