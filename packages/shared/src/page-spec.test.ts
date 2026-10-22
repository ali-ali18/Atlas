import { describe, expect, it } from "vitest";
import {
	PAGE_MAX_BLOCKS,
	PAGE_MAX_CHARTS,
	PAGE_MAX_JSON_CHARS,
	applyPagePatch,
	countPageBlocks,
	parsePagePatchOps,
	parsePageSources,
	parsePageSpec,
	summarizePageSpec,
	type PageSpec,
} from "./page-spec.js";
import { parseConversationCard } from "./skill-card.js";

const chart = {
	type: "bar",
	x: "mes",
	series: [{ key: "total" }],
	data: [
		{ mes: "jan", total: 10 },
		{ mes: "fev", total: 20 },
	],
};

const base = {
	v: 1,
	title: "Forecast Q4",
	summary: "Receita acima da meta",
	blocks: [
		{ type: "heading", text: "Resumo" },
		{ type: "stats", items: [{ label: "Receita", value: 120000, unit: "brl", delta: { value: 8, direction: "up", label: "vs meta" } }] },
		{ type: "bar_list", items: [{ label: "Sul", value: 5 }, { label: "Norte", value: 3, display: "3 mil" }] },
		{ type: "table", columns: [{ key: "a", label: "A" }, { key: "b", label: "B", align: "right" }], rows: [{ a: "x", b: 1 }] },
	],
};

function ok(input: unknown): PageSpec {
	const parsed = parsePageSpec(input);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.spec;
}

describe("parsePageSpec", () => {
	it("aceita uma página válida e gera ids estáveis e únicos", () => {
		const spec = ok(base);
		const ids = spec.blocks.map((b) => b.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(spec.blocks[0]).toMatchObject({ type: "heading", id: expect.stringMatching(/^heading-/) });
		expect(spec.title).toBe("Forecast Q4");
	});

	it("aceita o JSON como texto e rejeita texto inválido ou grande demais", () => {
		expect(parsePageSpec(JSON.stringify(base)).ok).toBe(true);
		expect(parsePageSpec("{oops").ok).toBe(false);
		expect(parsePageSpec("x".repeat(PAGE_MAX_JSON_CHARS + 1))).toMatchObject({ ok: false });
	});

	it("rejeita página vazia e sem título", () => {
		expect(parsePageSpec({ title: "T", blocks: [] })).toMatchObject({ ok: false });
		expect(parsePageSpec({ blocks: base.blocks })).toMatchObject({ ok: false, error: expect.stringContaining("title") });
		expect(parsePageSpec(null)).toMatchObject({ ok: false });
	});

	it("valida o gráfico com o parseChartSpec e cita o bloco", () => {
		const bad = parsePageSpec({ title: "T", blocks: [{ type: "chart", spec: { type: "bar", x: "m", series: [], data: [] } }] });
		expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("blocks[0].spec") });
		expect(ok({ title: "T", blocks: [{ type: "chart", spec: chart }] }).blocks[0]).toMatchObject({ type: "chart" });
	});

	it("rejeita ids duplicados", () => {
		const dup = parsePageSpec({ title: "T", blocks: [{ id: "a", type: "heading", text: "1" }, { id: "A", type: "heading", text: "2" }] });
		expect(dup).toMatchObject({ ok: false, error: expect.stringContaining("duplicate id") });
	});

	it("limita blocos (inclusive os de dentro das abas) e gráficos", () => {
		const many = Array.from({ length: PAGE_MAX_BLOCKS + 1 }, (_, i) => ({ type: "heading", text: `h${i}` }));
		expect(parsePageSpec({ title: "T", blocks: many })).toMatchObject({ ok: false, error: expect.stringContaining("too many blocks") });
		const charts = Array.from({ length: PAGE_MAX_CHARTS + 1 }, () => ({ type: "chart", spec: chart }));
		expect(parsePageSpec({ title: "T", blocks: charts })).toMatchObject({ ok: false, error: expect.stringContaining("too many charts") });
		const tabs = { type: "tabs", tabs: [0, 1].map((t) => ({ label: `t${t}`, blocks: Array.from({ length: 15 }, () => ({ type: "heading", text: "h" })) })) };
		expect(parsePageSpec({ title: "T", blocks: [tabs, { type: "heading", text: "x" }] })).toMatchObject({ ok: false });
	});

	it("limites de stats, tabela, markdown e barras", () => {
		const stat = { label: "a", value: 1 };
		expect(parsePageSpec({ title: "T", blocks: [{ type: "stats", items: Array(9).fill(stat) }] }).ok).toBe(false);
		expect(parsePageSpec({ title: "T", blocks: [{ type: "stats", items: [{ label: "a", value: Number.NaN }] }] }).ok).toBe(false);
		expect(parsePageSpec({ title: "T", blocks: [{ type: "markdown", text: "x".repeat(4001) }] }).ok).toBe(false);
		expect(parsePageSpec({ title: "T", blocks: [{ type: "bar_list", items: Array(31).fill({ label: "a", value: 1 }) }] }).ok).toBe(false);
		const cols = Array.from({ length: 11 }, (_, i) => ({ key: `c${i}`, label: "c" }));
		expect(parsePageSpec({ title: "T", blocks: [{ type: "table", columns: cols, rows: [] }] }).ok).toBe(false);
		const rows = Array.from({ length: 101 }, () => ({ a: 1 }));
		expect(parsePageSpec({ title: "T", blocks: [{ type: "table", columns: [{ key: "a", label: "A" }], rows }] }).ok).toBe(false);
	});

	it("abas: 2 a 6, um nível só", () => {
		const leaf = [{ type: "heading", text: "h" }];
		expect(parsePageSpec({ title: "T", blocks: [{ type: "tabs", tabs: [{ label: "a", blocks: leaf }] }] }).ok).toBe(false);
		const nested = { type: "tabs", tabs: [{ label: "a", blocks: [{ type: "tabs", tabs: [] }] }, { label: "b", blocks: leaf }] };
		expect(parsePageSpec({ title: "T", blocks: [nested] })).toMatchObject({ ok: false, error: expect.stringContaining("nested") });
		const spec = ok({ title: "T", blocks: [{ type: "tabs", tabs: [{ label: "Visão geral", blocks: leaf }, { label: "Detalhe", blocks: leaf }] }] });
		const block = spec.blocks[0]!;
		expect(block.type === "tabs" && block.tabs.map((t) => t.id)).toEqual(["visao-geral", "detalhe"]);
		expect(countPageBlocks(spec)).toEqual({ blocks: 3, charts: 0 });
	});
});

describe("parsePageSources", () => {
	it("aceita até 20, deduplica e exige http(s)", () => {
		expect(parsePageSources(undefined)).toEqual({ ok: true, sources: [] });
		expect(parsePageSources([{ title: "A", url: "https://a.com/x" }, { title: "A", url: "https://a.com/x" }])).toMatchObject({ ok: true, sources: [{ title: "A" }] });
		expect(parsePageSources([{ title: "A", url: "javascript:alert(1)" }]).ok).toBe(false);
		expect(parsePageSources(Array(21).fill({ title: "A" })).ok).toBe(false);
	});
});

describe("applyPagePatch", () => {
	const spec = ok({
		title: "T",
		blocks: [
			{ id: "intro", type: "heading", text: "Oi" },
			{ id: "tabs1", type: "tabs", tabs: [{ label: "A", blocks: [{ id: "in-a", type: "markdown", text: "a" }] }, { label: "B", blocks: [{ id: "in-b", type: "markdown", text: "b" }] }] },
		],
	});

	it("replace, insert_after e remove por id, sem mutar o original", () => {
		const before = JSON.stringify(spec);
		const parsed = applyPagePatch(spec, [
			{ op: "replace", id: "intro", block: { type: "heading", text: "Novo" } },
			{ op: "insert_after", id: "in-a", block: { id: "extra", type: "markdown", text: "x" } },
			{ op: "remove", id: "in-b" },
		]);
		expect(JSON.stringify(spec)).toBe(before);
		expect(parsed.ok).toBe(false); // aba B ficou sem blocos
		const next = applyPagePatch(spec, [
			{ op: "replace", id: "intro", block: { type: "heading", text: "Novo" } },
			{ op: "insert_after", id: "in-a", block: { id: "extra", type: "markdown", text: "x" } },
			{ op: "insert_after", block: { id: "fim", type: "heading", text: "Fim" } },
		]);
		expect(next.ok).toBe(true);
		if (next.ok) {
			expect(next.spec.blocks[0]).toMatchObject({ id: "intro", text: "Novo" });
			const tabs = next.spec.blocks[1]!;
			expect(tabs.type === "tabs" && tabs.tabs[0]!.blocks.map((b) => b.id)).toEqual(["in-a", "extra"]);
			expect(next.spec.blocks.at(-1)).toMatchObject({ id: "fim" });
		}
	});

	it("id inexistente e bloco inválido falham com mensagem útil", () => {
		expect(applyPagePatch(spec, [{ op: "remove", id: "nada" }])).toMatchObject({ ok: false, error: expect.stringContaining("page_read") });
		expect(applyPagePatch(spec, [{ op: "replace", id: "intro", block: { type: "stats", items: [] } }]).ok).toBe(false);
		expect(applyPagePatch(spec, [{ op: "remove", id: "intro" }, { op: "remove", id: "tabs1" }]).ok).toBe(false);
	});

	it("parsePagePatchOps valida a forma dos ops", () => {
		expect(parsePagePatchOps([])).toMatchObject({ ok: false });
		expect(parsePagePatchOps([{ op: "zap", id: "a" }]).ok).toBe(false);
		expect(parsePagePatchOps([{ op: "remove" }]).ok).toBe(false);
		expect(parsePagePatchOps([{ op: "remove", id: "a" }]).ok).toBe(true);
	});
});

describe("summarizePageSpec e cartão", () => {
	it("resume por tipo de bloco", () => {
		expect(summarizePageSpec(ok(base))).toMatch(/Page "Forecast Q4": 4 blocks \(.*1 stats.*\)/);
	});

	it("o cartão persistido faz round-trip e rejeita revisão ou spec inválidos", () => {
		const spec = ok(base);
		const card = { v: 1, kind: "page", pageId: "p1", revision: 2, title: "Forecast Q4", action: "updated", spec, sourceCount: 3 };
		expect(parseConversationCard(JSON.stringify(card))).toMatchObject({ kind: "page", pageId: "p1", revision: 2, action: "updated", sourceCount: 3 });
		expect(parseConversationCard(JSON.stringify({ ...card, revision: 0 }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ ...card, spec: { title: "x", blocks: [] } }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ ...card, spec: undefined }))).toMatchObject({ kind: "page" });
	});
});
