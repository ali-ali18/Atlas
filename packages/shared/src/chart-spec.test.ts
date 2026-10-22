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
