import { describe, expect, it } from "vitest";
import {
	PAGE_MAX_CHARTS,
	PAGE_MAX_DEPTH,
	PAGE_MAX_JSON_CHARS,
	PAGE_MAX_NODES,
	applyPagePatch,
	countPageNodes,
	parsePagePatchOps,
	parsePageSources,
	parsePageSpec,
	summarizePageSpec,
	walkPageNodes,
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

const stat = (label: string, value: number | string = 1) => ({ type: "stat", props: { label, value } });
const stack = (...children: unknown[]) => ({ type: "stack", children });

/** Página v2 de exemplo: grid de KPIs, abas com listas, gráfico e tabela. */
const tree = {
	v: 2,
	title: "Pedidos da semana",
	summary: "Receita acima da meta",
	palette: "grove",
	root: {
		type: "stack",
		children: [
			{ type: "heading", props: { text: "Resumo", level: 2 } },
			{ id: "kpis", type: "grid", props: { cols: 2 }, children: [{ ...stat("Receita", 120000), props: { label: "Receita", value: 120000, unit: "BRL", delta: { value: 8, kind: "percent", direction: "up", label: "vs meta" }, span: 2 } }, stat("Pedidos", 42)] },
			{ id: "abas", type: "tabs", props: { tabs: [{ id: "regiao", label: "Por região" }, { id: "cliente", label: "Por cliente" }] }, children: [
				{ type: "tab", props: { tab: "regiao" }, children: [{ id: "por-regiao", type: "bar_list", props: { items: [{ label: "Sul", value: 5 }, { label: "Norte", value: 3, display: "3 mil" }] } }] },
				{ type: "tab", props: { tab: "cliente" }, children: [{ type: "list", props: { items: [{ title: "Loja Exemplo", value: 10 }] } }] },
			] },
			{ type: "chart", props: { spec: { ...chart, palette: "ocean" } } },
			{ type: "table", props: { columns: [{ key: "a", label: "A" }, { key: "b", label: "B", align: "right" }], rows: [{ a: "x", b: 1 }] } },
		],
	},
};

function ok(input: unknown): PageSpec {
	const parsed = parsePageSpec(input);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.spec;
}

const ids = (spec: PageSpec): string[] => {
	const out: string[] = [];
	walkPageNodes(spec.root, (n) => out.push(n.id));
	return out;
};

describe("parsePageSpec v2", () => {
	it("aceita a árvore, gera ids únicos e estáveis e mantém a paleta", () => {
		const spec = ok(tree);
		expect(spec).toMatchObject({ v: 2, title: "Pedidos da semana", palette: "grove" });
		const all = ids(spec);
		expect(new Set(all).size).toBe(all.length);
		expect(spec.root.id).toBe("root");
		expect(all).toContain("kpis");
		expect(countPageNodes(spec)).toMatchObject({ charts: 1 });
		const grid = spec.root.children![1]!;
		expect(grid.type === "grid" && grid.props.cols).toBe(2);
		// span só vale dentro de grid e fica no props
		expect(grid.children![0]!.props).toMatchObject({ span: 2 });
	});

	it("aceita o JSON como texto e rejeita texto inválido ou grande demais", () => {
		expect(parsePageSpec(JSON.stringify(tree)).ok).toBe(true);
		expect(parsePageSpec("{oops").ok).toBe(false);
		expect(parsePageSpec("x".repeat(PAGE_MAX_JSON_CHARS + 1))).toMatchObject({ ok: false });
	});

	it("rejeita página sem título, sem raiz e versão desconhecida", () => {
		expect(parsePageSpec({ v: 2, root: stack(stat("a")) })).toMatchObject({ ok: false, error: expect.stringContaining("title") });
		expect(parsePageSpec({ v: 2, title: "T" })).toMatchObject({ ok: false, error: expect.stringContaining("root is required") });
		expect(parsePageSpec({ v: 3, title: "T", root: stack(stat("a")) })).toMatchObject({ ok: false, error: expect.stringContaining("v must be 2") });
		expect(parsePageSpec(null)).toMatchObject({ ok: false });
	});

	it("tipo desconhecido lista a whitelist; props soltas no nó valem como props", () => {
		expect(parsePageSpec({ title: "T", v: 2, root: { type: "iframe" } })).toMatchObject({ ok: false, error: expect.stringContaining("root.type must be one of") });
		const spec = ok({ v: 2, title: "T", root: stack({ type: "stat", label: "Receita", value: 5 }) });
		expect(spec.root.children![0]!.props).toMatchObject({ label: "Receita", value: 5 });
	});

	it("valida o gráfico com o parseChartSpec e cita o caminho do nó", () => {
		const bad = parsePageSpec({ v: 2, title: "T", root: stack({ type: "chart", props: { spec: { type: "bar", x: "m", series: [], data: [] } } }) });
		expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("root.children[0].props.spec") });
		const spec = ok({ v: 2, title: "T", root: stack({ type: "chart", props: { spec: { ...chart, type: "gauge", series: [{ key: "total" }], data: [{ mes: "x", total: 60 }], max: 100 } } }) });
		expect(spec.root.children![0]).toMatchObject({ type: "chart" });
	});

	it("rejeita ids duplicados", () => {
		const dup = parsePageSpec({ v: 2, title: "T", root: stack({ id: "a", type: "divider" }, { id: "A", type: "divider" }) });
		expect(dup).toMatchObject({ ok: false, error: expect.stringContaining("duplicate id") });
	});

	it("limites: nós (120), profundidade (6) e gráficos (8)", () => {
		const many = Array.from({ length: PAGE_MAX_NODES }, () => ({ type: "divider" }));
		expect(parsePageSpec({ v: 2, title: "T", root: stack(...many) })).toMatchObject({ ok: false, error: expect.stringContaining("too many nodes") });
		expect(parsePageSpec({ v: 2, title: "T", root: stack(...many.slice(0, PAGE_MAX_NODES - 1)) }).ok).toBe(true);
		let deep: unknown = { type: "divider" };
		for (let i = 0; i < PAGE_MAX_DEPTH; i += 1) deep = stack(deep);
		expect(parsePageSpec({ v: 2, title: "T", root: deep })).toMatchObject({ ok: false, error: expect.stringContaining("too deep") });
		const charts = Array.from({ length: PAGE_MAX_CHARTS + 1 }, () => ({ type: "chart", props: { spec: chart } }));
		expect(parsePageSpec({ v: 2, title: "T", root: stack(...charts) })).toMatchObject({ ok: false, error: expect.stringContaining("too many charts") });
	});

	it("folhas não têm filhos e containers não ficam vazios", () => {
		expect(parsePageSpec({ v: 2, title: "T", root: stack({ type: "stat", props: { label: "a", value: 1 }, children: [{ type: "divider" }] }) })).toMatchObject({ ok: false, error: expect.stringContaining('"stat" takes no children') });
		expect(parsePageSpec({ v: 2, title: "T", root: { type: "grid", props: { cols: 2 } } })).toMatchObject({ ok: false, error: expect.stringContaining("non-empty array") });
	});

	it("props dos componentes: grid.cols, span, tone, delta, progress, badge, callout", () => {
		const bad = (node: unknown) => parsePageSpec({ v: 2, title: "T", root: stack(node) });
		expect(bad({ type: "grid", props: { cols: 5 }, children: [{ type: "divider" }] })).toMatchObject({ ok: false, error: expect.stringContaining("1 to 4") });
		expect(bad({ type: "grid", props: { cols: 2 }, children: [{ type: "divider", props: { span: 3 } }] })).toMatchObject({ ok: false, error: expect.stringContaining("span must be an integer from 1 to 2") });
		expect(bad({ type: "stat", props: { label: "a", value: 1, tone: "rosa" } })).toMatchObject({ ok: false, error: expect.stringContaining("neutral, positive, warning, critical, accent") });
		expect(bad({ type: "stat", props: { label: "a", value: Number.NaN } })).toMatchObject({ ok: false });
		expect(bad({ type: "stat", props: { label: "a", value: 1, delta: { value: 2 } } })).toMatchObject({ ok: false, error: expect.stringContaining("direction") });
		expect(bad({ type: "progress", props: { label: "a", value: 1, max: 0 } })).toMatchObject({ ok: false, error: expect.stringContaining("greater than 0") });
		expect(bad({ type: "callout", props: { text: "x", tone: "danger" } })).toMatchObject({ ok: false, error: expect.stringContaining("info, success, warning, critical") });
		expect(bad({ type: "text", props: { markdown: "x".repeat(4001) } })).toMatchObject({ ok: false, error: expect.stringContaining("too long") });
		expect(bad({ type: "bar_list", props: { items: Array(31).fill({ label: "a", value: 1 }) } })).toMatchObject({ ok: false });
		const cols = Array.from({ length: 11 }, (_, i) => ({ key: `c${i}`, label: "c" }));
		expect(bad({ type: "table", props: { columns: cols, rows: [] } })).toMatchObject({ ok: false });
		expect(bad({ type: "table", props: { columns: [{ key: "a", label: "A" }], rows: Array(101).fill({ a: 1 }) } })).toMatchObject({ ok: false });
		expect(bad({ type: "kanban", props: { columns: [{ title: "A", items: [{ title: "x", badge: "novo" }] }] } }).ok).toBe(true);
		expect(bad({ type: "timeline", props: { items: [{ date: "12/11", title: "Vence", tone: "warning" }] } }).ok).toBe(true);
		// span em filho de stack é ignorado, não quebra
		expect(ok({ v: 2, title: "T", root: stack({ type: "divider", props: { span: 3 } }) }).root.children![0]!.props).toEqual({});
	});

	it("tabs: 2 a 6, um nó `tab` por aba declarada, sem filhos soltos", () => {
		const tab = (id: string) => ({ type: "tab", props: { tab: id }, children: [{ type: "divider" }] });
		const tabs = (declared: unknown[], children: unknown[]) => parsePageSpec({ v: 2, title: "T", root: stack({ type: "tabs", props: { tabs: declared }, children }) });
		expect(tabs([{ id: "a", label: "A" }], [tab("a")])).toMatchObject({ ok: false, error: expect.stringContaining("between 2 and 6") });
		expect(tabs([{ label: "A" }, { label: "B" }], [tab("a")])).toMatchObject({ ok: false, error: expect.stringContaining("keep them in sync") });
		expect(tabs([{ label: "A" }, { label: "B" }], [tab("a"), { type: "divider" }])).toMatchObject({ ok: false, error: expect.stringContaining('must be "tab" nodes') });
		expect(tabs([{ label: "A" }, { label: "B" }], [tab("a"), tab("z")])).toMatchObject({ ok: false, error: expect.stringContaining("declared in tabs.props.tabs") });
		expect(parsePageSpec({ v: 2, title: "T", root: stack(tab("a")) })).toMatchObject({ ok: false, error: expect.stringContaining("direct child of") });
		// sem props.tab, a ordem decide
		const spec = ok({ v: 2, title: "T", root: stack({ type: "tabs", props: { tabs: [{ label: "Visão geral" }, { label: "Detalhe" }] }, children: [{ type: "tab", children: [{ type: "divider" }] }, { type: "tab", children: [{ type: "divider" }] }] }) });
		const node = spec.root.children![0]!;
		expect(node.type === "tabs" && node.props.tabs.map((t) => t.id)).toEqual(["visao-geral", "detalhe"]);
	});

	it("paleta: nome, cores próprias válidas e erros claros", () => {
		expect(ok({ ...tree, palette: { colors: ["#2563EB", "#abc"] } }).palette).toEqual({ colors: ["#2563eb", "#aabbcc"] });
		expect(parsePageSpec({ ...tree, palette: "neon" })).toMatchObject({ ok: false, error: expect.stringContaining("palette must be one of") });
		expect(parsePageSpec({ ...tree, palette: { colors: ["azul"] } })).toMatchObject({ ok: false, error: expect.stringContaining("hex color") });
		expect(parsePageSpec({ ...tree, palette: { colors: Array(7).fill("#000000") } })).toMatchObject({ ok: false });
		expect(ok({ ...tree, palette: undefined }).palette).toBeUndefined();
	});
});

describe("páginas v1 (compatibilidade)", () => {
	const v1 = {
		v: 1,
		title: "Forecast Q4",
		summary: "Receita acima da meta",
		blocks: [
			{ type: "heading", text: "Resumo" },
			{ type: "stats", items: [{ label: "Receita", value: 120000, unit: "brl", delta: { value: 8, direction: "up", label: "vs meta" } }, { label: "Churn", value: "baixo" }] },
			{ id: "por-regiao", type: "bar_list", items: [{ label: "Sul", value: 5 }, { label: "Norte", value: 3, display: "3 mil" }] },
			{ type: "table", columns: [{ key: "a", label: "A" }], rows: [{ a: "x" }] },
			{ type: "markdown", text: "**oi**" },
			{ type: "chart", spec: chart },
			{ type: "tabs", tabs: [{ label: "Visão", blocks: [{ id: "in-a", type: "markdown", text: "a" }] }, { id: "det", label: "Detalhe", blocks: [{ type: "heading", text: "b" }] }] },
		],
	};

	it("vira v2: stack na raiz, stats em grid, markdown em text, abas com nós tab, ids dos blocos mantidos", () => {
		const spec = ok(v1);
		expect(spec).toMatchObject({ v: 2, title: "Forecast Q4", summary: "Receita acima da meta" });
		expect(spec.root).toMatchObject({ type: "stack", id: "root" });
		expect(spec.root.children!.map((n) => n.type)).toEqual(["heading", "grid", "bar_list", "table", "text", "chart", "tabs"]);
		expect(spec.root.children![2]!.id).toBe("por-regiao");
		const grid = spec.root.children![1]!;
		expect(grid.type === "grid" && grid.props.cols).toBe(2);
		expect(grid.children![0]!.props).toMatchObject({ label: "Receita", delta: { value: 8, kind: "percent", direction: "up" } });
		const tabs = spec.root.children![6]!;
		expect(tabs.type === "tabs" && tabs.props.tabs.map((t) => t.id)).toEqual(["visao", "det"]);
		expect(tabs.children!.map((n) => n.type)).toEqual(["tab", "tab"]);
		expect(ids(spec)).toContain("in-a");
		// idempotente: o v2 resultante volta a ser lido igual
		expect(parsePageSpec(JSON.stringify(spec))).toEqual({ ok: true, spec });
	});

	it("um v1 grande (30 blocos de 8 stats) não quebra na conversão", () => {
		const stats = { type: "stats", items: Array.from({ length: 8 }, (_, i) => ({ label: `s${i}`, value: i })) };
		expect(parsePageSpec({ v: 1, title: "Grande", blocks: Array(30).fill(stats) }).ok).toBe(true);
		expect(parsePageSpec({ title: "Sem v", blocks: [{ type: "heading", text: "x" }] }).ok).toBe(true);
		expect(parsePageSpec({ v: 1, title: "T", blocks: [] })).toMatchObject({ ok: false });
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
		v: 2,
		title: "T",
		root: { id: "raiz", type: "stack", children: [
			{ id: "intro", type: "heading", props: { text: "Oi" } },
			{ id: "abas", type: "tabs", props: { tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, children: [
				{ id: "tab-a", type: "tab", props: { tab: "a" }, children: [{ id: "in-a", type: "text", props: { markdown: "a" } }] },
				{ id: "tab-b", type: "tab", props: { tab: "b" }, children: [{ id: "in-b", type: "text", props: { markdown: "b" } }] },
			] },
		] },
	});

	it("replace, insert_after, append_child e remove por id, sem mutar o original", () => {
		const before = JSON.stringify(spec);
		const next = applyPagePatch(spec, [
			{ op: "replace", id: "intro", node: { type: "heading", props: { text: "Novo" } } },
			{ op: "insert_after", id: "in-a", node: { id: "extra", type: "text", props: { markdown: "x" } } },
			{ op: "append_child", id: "tab-b", node: { id: "kpi", type: "stat", props: { label: "A", value: 1 } } },
			{ op: "insert_after", node: { id: "fim", type: "heading", props: { text: "Fim" } } },
			{ op: "remove", id: "in-b" },
		]);
		expect(JSON.stringify(spec)).toBe(before);
		expect(next.ok).toBe(true);
		if (next.ok) {
			expect(next.spec.root.children![0]).toMatchObject({ id: "intro", props: { text: "Novo" } });
			const tabs = next.spec.root.children![1]!;
			expect(tabs.children![0]!.children!.map((n) => n.id)).toEqual(["in-a", "extra"]);
			expect(tabs.children![1]!.children!.map((n) => n.id)).toEqual(["kpi"]);
			expect(next.spec.root.children!.at(-1)).toMatchObject({ id: "fim" });
		}
	});

	it("id inexistente, nó inválido, raiz e container vazio falham com mensagem útil", () => {
		expect(applyPagePatch(spec, [{ op: "remove", id: "nada" }])).toMatchObject({ ok: false, error: expect.stringContaining("page_read") });
		expect(applyPagePatch(spec, [{ op: "append_child", id: "nada", node: { type: "divider" } }])).toMatchObject({ ok: false });
		expect(applyPagePatch(spec, [{ op: "replace", id: "intro", node: { type: "stat", props: { label: "x" } } }]).ok).toBe(false);
		expect(applyPagePatch(spec, [{ op: "remove", id: "raiz" }])).toMatchObject({ ok: false, error: expect.stringContaining("root node cannot be removed") });
		expect(applyPagePatch(spec, [{ op: "remove", id: "intro" }, { op: "remove", id: "abas" }]).ok).toBe(false);
		// tirar um `tab` deixa as abas fora de sincronia
		expect(applyPagePatch(spec, [{ op: "remove", id: "tab-b" }])).toMatchObject({ ok: false, error: expect.stringContaining("keep them in sync") });
		// a raiz pode ser trocada mantendo o id
		const swapped = applyPagePatch(spec, [{ op: "replace", id: "raiz", node: { type: "grid", props: { cols: 2 }, children: [{ type: "divider" }] } }]);
		expect(swapped.ok && swapped.spec.root).toMatchObject({ id: "raiz", type: "grid" });
	});

	it("parsePagePatchOps valida a forma dos ops (aceita `block` como apelido de `node`)", () => {
		expect(parsePagePatchOps([])).toMatchObject({ ok: false });
		expect(parsePagePatchOps([{ op: "zap", id: "a" }]).ok).toBe(false);
		expect(parsePagePatchOps([{ op: "remove" }]).ok).toBe(false);
		expect(parsePagePatchOps([{ op: "append_child", node: { type: "divider" } }]).ok).toBe(false);
		expect(parsePagePatchOps([{ op: "remove", id: "a" }]).ok).toBe(true);
		expect(parsePagePatchOps([{ op: "replace", id: "a", block: { type: "divider" } }])).toEqual({ ok: true, ops: [{ op: "replace", id: "a", node: { type: "divider" } }] });
	});
});

describe("summarizePageSpec e cartão", () => {
	it("resume por tipo de componente e cita a paleta", () => {
		const summary = summarizePageSpec(ok(tree));
		expect(summary).toMatch(/Page "Pedidos da semana": \d+ nodes \(.*2 stat.*\), palette grove/);
	});

	it("o cartão persistido faz round-trip (inclusive com spec v1 antigo) e rejeita revisão ou spec inválidos", () => {
		const spec = ok(tree);
		const card = { v: 1, kind: "page", pageId: "p1", revision: 2, title: "Forecast Q4", action: "updated", spec, sourceCount: 3 };
		expect(parseConversationCard(JSON.stringify(card))).toMatchObject({ kind: "page", pageId: "p1", revision: 2, action: "updated", sourceCount: 3 });
		expect(parseConversationCard(JSON.stringify({ ...card, revision: 0 }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ ...card, spec: { title: "x", blocks: [] } }))).toBeNull();
		expect(parseConversationCard(JSON.stringify({ ...card, spec: undefined }))).toMatchObject({ kind: "page" });
		const old = parseConversationCard(JSON.stringify({ ...card, spec: { v: 1, title: "Velho", blocks: [{ type: "heading", text: "x" }] } }));
		expect(old).toMatchObject({ kind: "page", spec: { v: 2, title: "Velho" } });
	});
});
