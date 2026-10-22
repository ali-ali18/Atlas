import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { parsePageSpec, type PageSource, type PageSpec } from "@workspace/shared";
import type { PageRecord } from "@workspace/db";
import { persistConversationCardFromEvent } from "@workspace/db";
import { runComputerUse } from "./computer-use.js";
import { routeContextGroups } from "./context/intent-router.js";
import { assembleSystemPrompt, P_PAGES } from "./context/prompt-blocks.js";
import { NATIVE_TOOL_GROUPS, nativeToolGroupOf } from "./context/native-tools.js";
import { PAGE_TOOLS, PAGE_TOOL_NAMES, type PagesStore } from "./tools/pages.js";

/** Páginas vivas no loop: a tool aparece por intenção, valida o spec, emite o evento e atualiza no lugar. */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
	};
});

const toolCall = (name: string, args: Record<string, unknown>, id = `c-${name}`): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] },
});
const say = (text: string): CompleteChatWithToolsResult => ({ model: "test-model", message: { role: "assistant", content: text } });

/** Store em memória com a mesma regra de dono do db: de outro usuário = não existe. */
function memoryStore() {
	const rows: Array<PageRecord & { userId: string }> = [];
	const store: PagesStore = {
		create: async (userId, input) => {
			const row = {
				id: `page-${rows.length + 1}`, userId, botId: input.botId, conversationId: input.conversationId ?? null, title: input.spec.title, spec: input.spec,
				sources: input.sources, revision: 1, refreshedAt: null, createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z",
			};
			rows.push(row);
			return row;
		},
		get: async (id, userId) => rows.find((row) => row.id === id && row.userId === userId) ?? null,
		list: async (userId, botId) => rows.filter((row) => row.userId === userId && row.botId === botId).map((row) => ({ id: row.id, botId: row.botId, title: row.title, revision: row.revision, updatedAt: row.updatedAt, refreshedAt: null, sourceCount: row.sources.length })),
		update: async (id, userId, input) => {
			const row = rows.find((r) => r.id === id && r.userId === userId);
			if (!row) return { ok: false, error: "not_found" };
			if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) return { ok: false, error: "conflict" };
			row.spec = input.spec;
			row.title = input.spec.title;
			if (input.sources) row.sources = input.sources;
			row.revision += 1;
			return { ok: true, page: row };
		},
	};
	return { rows, store };
}

async function run(userText: string, queue: CompleteChatWithToolsResult[], store: PagesStore, extra: Record<string, unknown> = {}) {
	const events: Array<Record<string, unknown> & { type: string }> = [];
	const offered: string[][] = [];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => { throw new Error("sem sandbox"); },
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: userText }],
		botId: "bot-1", userId: "user-1", conversationId: "conv-pg", runId: "run-pg", origin: "chat", maxSteps: 8,
		pagesStore: store,
		...extra,
		onEvent: (event) => { events.push(event as never); },
		streamChat: async (params) => {
			offered.push(params.tools.map((t) => t.function.name));
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { events, offered };
}

/** Página v2 em árvore: grid de KPIs, barras com id e gráfico com meta, paleta "grove". */
const forecast = {
	title: "Forecast do trimestre",
	summary: "Receita 8% acima da meta",
	palette: "grove",
	root: {
		type: "stack",
		children: [
			{ type: "grid", props: { cols: 2 }, children: [
				{ type: "stat", props: { label: "Receita", value: 120000, unit: "BRL", delta: { value: 8, kind: "percent", direction: "up", label: "vs meta" } } },
				{ type: "stat", props: { label: "Pedidos", value: 42 } },
			] },
			{ id: "por-regiao", type: "bar_list", props: { items: [{ label: "Sul", value: 70 }, { label: "Norte", value: 50 }] } },
		],
	},
	sources: [{ title: "CRM", url: "https://crm.example.com/q4" }],
};

const resultOf = (events: Array<Record<string, unknown>>, name: string) => events.filter((e) => e.type === "tool_result" && e.name === name) as Array<{ ok: boolean; summary: string }>;

describe("grupo pages", () => {
	it("é um grupo adiado, com as quatro tools, e a intenção de dashboard/relatório/painel o carrega", () => {
		expect(NATIVE_TOOL_GROUPS.pages.tools).toEqual([...PAGE_TOOL_NAMES]);
		expect(nativeToolGroupOf("page_create")).toBe("pages");
		for (const text of ["monta meu forecast do trimestre", "quero um dashboard de vendas", "cria um painel com os KPIs", "faz um relatório semanal de leads", "build me a live page of this", "me dá uma visão geral do mês"]) {
			expect(routeContextGroups({ text }).has("pages"), text).toBe(true);
		}
		for (const text of ["oi, tudo bem?", "qual a capital da França?", "abre o site do banco"]) {
			expect(routeContextGroups({ text }).has("pages"), text).toBe(false);
		}
	});

	it("o procedimento só entra no prompt com o grupo e protege a regra dos números reais", () => {
		expect(assembleSystemPrompt(new Set())).not.toContain("Live pages");
		const prompt = assembleSystemPrompt(new Set(["pages"]));
		expect(prompt).toContain(P_PAGES[0]);
		expect(prompt).toMatch(/never invent/);
		expect(prompt).toMatch(/in place/);
		// composição livre, paleta e cores só pela paleta (regras do prompt protegidas por string)
		expect(prompt).toMatch(/COMPOSE it as a tree/);
		expect(prompt).toMatch(/`palette`/);
		expect(prompt).toMatch(/readable on a phone/);
		expect(prompt).toMatch(/never hex/);
	});

	it("as tools descrevem a árvore (componentes, tone, limites) sem inflar o prefixo", () => {
		const create = PAGE_TOOLS.find((tool) => tool.function.name === "page_create")!;
		const description = create.function.description!;
		for (const word of ["grid", "tabs", "stat", "chart", "kanban", "timeline", "progress", "callout", "tone", "120 nodes"]) expect(description, word).toContain(word);
		expect(JSON.stringify(create.function.parameters)).toContain("grove");
		expect((create.function.parameters as { required: string[] }).required).toEqual(["title", "root"]);
		const update = PAGE_TOOLS.find((tool) => tool.function.name === "page_update")!;
		expect(JSON.stringify(update.function.parameters)).toContain("append_child");
		expect(JSON.stringify(PAGE_TOOLS).length).toBeLessThan(9000);
	});
});

describe("page_* no loop do agente", () => {
	it("replay: \"monta meu forecast do trimestre\" carrega as tools, cria a página, emite o evento e persiste o cartão", async () => {
		const { rows, store } = memoryStore();
		const { events, offered } = await run("monta meu forecast do trimestre", [
			toolCall("page_create", forecast),
			say("Pronto, montei o forecast."),
		], store);
		expect(offered[0]).toEqual(expect.arrayContaining(PAGE_TOOL_NAMES as string[]));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ userId: "user-1", botId: "bot-1", conversationId: "conv-pg", revision: 1 });
		expect(rows[0]!.sources).toEqual([{ title: "CRM", url: "https://crm.example.com/q4" }]);
		const [result] = resultOf(events, "page_create");
		expect(result!.ok).toBe(true);
		expect(result!.summary).toContain("page-1");
		expect(result!.summary).toMatch(/already shows/);
		expect(result!.summary).toMatch(/one short line/);
		const page = events.find((e) => e.type === "page") as { action: string; pageId: string; revision: number; spec: PageSpec; sourceCount: number };
		expect(page).toMatchObject({ action: "created", pageId: "page-1", revision: 1, sourceCount: 1 });
		expect(page.spec).toMatchObject({ v: 2, palette: "grove", root: { type: "stack" } });
		expect(page.spec.root.children!.map((n) => n.type)).toEqual(["grid", "bar_list"]);
		expect(vi.mocked(persistConversationCardFromEvent)).toHaveBeenCalledWith("conv-pg", expect.objectContaining({ type: "page", pageId: "page-1" }));
	});

	it("sem intenção de página as tools ficam adiadas (prefixo pequeno); rotina e subagente não as recebem", async () => {
		const { store } = memoryStore();
		const chat = await run("oi, tudo bem?", [say("Oi!")], store);
		for (const name of PAGE_TOOL_NAMES) expect(chat.offered[0]).not.toContain(name);
		const routine = await run("monta meu forecast do trimestre", [say("ok")], store, { origin: "routine" });
		for (const name of PAGE_TOOL_NAMES) expect(routine.offered[0]).not.toContain(name);
		const anonymous = await run("monta meu forecast do trimestre", [say("ok")], store, { userId: undefined });
		for (const name of PAGE_TOOL_NAMES) expect(anonymous.offered[0]).not.toContain(name);
	});

	it("spec inválido vira erro com a mensagem do parser e nada é gravado nem emitido", async () => {
		const { rows, store } = memoryStore();
		const { events } = await run("monta um dashboard de vendas", [
			toolCall("page_create", { title: "Vendas", root: { type: "stack", children: [{ type: "chart", props: { spec: { type: "bar", x: "m", series: [], data: [] } } }] } }),
			say("Não consegui."),
		], store);
		const [result] = resultOf(events, "page_create");
		expect(result!.ok).toBe(false);
		expect(result!.summary).toMatch(/Invalid page: root\.children\[0\]\.props\.spec/);
		expect(rows).toHaveLength(0);
		expect(events.some((e) => e.type === "page")).toBe(false);
	});

	it("limites e props inválidas chegam ao modelo com a correção possível (121 nós, grid.cols, tipo desconhecido)", async () => {
		const { store } = memoryStore();
		const many = Array.from({ length: 121 }, () => ({ type: "divider" }));
		const { events } = await run("cria um painel", [
			toolCall("page_create", { title: "x", root: { type: "stack", children: many } }, "a"),
			toolCall("page_create", { title: "x", root: { type: "grid", props: { cols: 9 }, children: [{ type: "divider" }] } }, "b"),
			toolCall("page_create", { title: "x", root: { type: "iframe" } }, "c"),
			say("falhou"),
		], store);
		const results = resultOf(events, "page_create");
		expect(results.map((r) => r.ok)).toEqual([false, false, false]);
		expect(results[0]!.summary).toMatch(/too many nodes/);
		expect(results[1]!.summary).toMatch(/cols must be an integer from 1 to 4/);
		expect(results[2]!.summary).toMatch(/type must be one of: section, grid/);
	});

	it("replay: \"cobrança das contas a receber\" compõe callout, progress, timeline, kanban e gauge na paleta sunset", async () => {
		const { rows, store } = memoryStore();
		const gauge = { type: "gauge", x: "m", series: [{ key: "v" }], data: [{ m: "Recebido", v: 62 }], max: 100, unit: "%" };
		const { events } = await run("monta um painel de cobrança das contas a receber", [
			toolCall("page_create", {
				title: "Cobrança · contas a receber",
				palette: "sunset",
				root: { type: "stack", children: [
					{ type: "callout", props: { title: "3 títulos vencidos", text: "R$ 12.400 em atraso há mais de 15 dias", tone: "warning" } },
					{ type: "progress", props: { label: "Meta de recebimento", value: 62000, max: 100000, unit: "BRL" } },
					{ type: "grid", props: { cols: 2 }, children: [
						{ type: "card", props: { title: "Vencimentos" }, children: [{ type: "timeline", props: { items: [{ date: "12/11", title: "Loja Exemplo", text: "R$ 4.200", tone: "warning" }] } }] },
						{ type: "chart", props: { spec: gauge } },
					] },
					{ id: "status", type: "kanban", props: { columns: [{ title: "A vencer", items: [{ title: "Loja Exemplo", badge: "R$ 4.200" }] }, { title: "Vencidas", items: [] }] } },
				] },
			}),
			say("Pronto."),
		], store);
		expect(resultOf(events, "page_create")[0]!.ok).toBe(true);
		expect(rows[0]!.spec.palette).toBe("sunset");
		const types: string[] = [];
		const walk = (n: PageSpec["root"]) => { types.push(n.type); n.children?.forEach(walk); };
		walk(rows[0]!.spec.root);
		expect(types).toEqual(expect.arrayContaining(["callout", "progress", "timeline", "kanban", "chart", "card", "grid"]));
		expect(resultOf(events, "page_create")[0]!.summary).toMatch(/palette sunset/);
	});

	it("página v1 já gravada continua legível e pode ser atualizada por ops (convertida para v2)", async () => {
		const { rows, store } = memoryStore();
		const v1 = parsePageSpec({ v: 1, title: "Antiga", blocks: [{ id: "por-regiao", type: "bar_list", items: [{ label: "Sul", value: 1 }] }, { type: "heading", text: "Fim" }] });
		if (!v1.ok) throw new Error(v1.error);
		await store.create("user-1", { botId: "bot-1", spec: v1.spec, sources: [] });
		const { events } = await run("atualiza meu dashboard", [
			toolCall("page_read", { page_id: "page-1" }, "r1"),
			toolCall("page_update", { page_id: "page-1", ops: [{ op: "replace", id: "por-regiao", node: { type: "bar_list", props: { items: [{ label: "Sul", value: 9 }] } } }, { op: "append_child", id: "root", node: { type: "badge", props: { text: "novo", tone: "accent" } } }] }, "u1"),
			say("ok"),
		], store);
		expect(resultOf(events, "page_read")[0]!.summary).toContain("- por-regiao [bar_list]");
		expect(resultOf(events, "page_update")[0]!.ok).toBe(true);
		expect(rows[0]!.spec.v).toBe(2);
		expect(rows[0]!.spec.root.children!.map((n) => n.type)).toEqual(["bar_list", "heading", "badge"]);
	});

	it("page_update com ops atualiza no lugar: mesmo pageId, revisão 2, evento \"updated\"", async () => {
		const { rows, store } = memoryStore();
		const { events } = await run("monta meu forecast do trimestre", [
			toolCall("page_create", forecast),
			toolCall("page_update", { page_id: "page-1", ops: [{ op: "replace", id: "por-regiao", node: { type: "bar_list", props: { items: [{ label: "Sul", value: 75 }] } } }], summary: "Receita 9% acima da meta", palette: "ocean" }),
			say("Atualizei."),
		], store);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.revision).toBe(2);
		expect(rows[0]!.spec.summary).toBe("Receita 9% acima da meta");
		expect(rows[0]!.spec.palette).toBe("ocean");
		const bars = rows[0]!.spec.root.children![1]!;
		expect(bars.type === "bar_list" && bars.props.items).toEqual([{ label: "Sul", value: 75 }]);
		const pages = events.filter((e) => e.type === "page") as Array<{ action: string; pageId: string; revision: number }>;
		expect(pages.map((p) => [p.action, p.pageId, p.revision])).toEqual([["created", "page-1", 1], ["updated", "page-1", 2]]);
		expect(resultOf(events, "page_update")[0]!.summary).toMatch(/updated in place/);
	});

	it("page_update: id desconhecido, ops e root juntos, e update vazio dão erro honesto", async () => {
		const { store } = memoryStore();
		const { events } = await run("monta meu forecast do trimestre", [
			toolCall("page_create", forecast),
			toolCall("page_update", { page_id: "page-1", ops: [{ op: "remove", id: "nao-existe" }] }, "u1"),
			toolCall("page_update", { page_id: "page-1", ops: [{ op: "remove", id: "por-regiao" }], root: forecast.root }, "u2"),
			toolCall("page_update", { page_id: "page-1" }, "u3"),
			say("ok"),
		], store);
		const updates = resultOf(events, "page_update");
		expect(updates.map((u) => u.ok)).toEqual([false, false, false]);
		expect(updates[0]!.summary).toMatch(/no node with id "nao-existe"/);
		expect(updates[1]!.summary).toMatch(/not both/);
		expect(updates[2]!.summary).toMatch(/Nothing to update/);
	});

	it("página de outro usuário: leitura e atualização respondem não encontrada e nada muda", async () => {
		const { rows, store } = memoryStore();
		await store.create("user-2", { botId: "bot-2", spec: parsePageSpec(forecast).ok ? (parsePageSpec(forecast) as { spec: PageSpec }).spec : (undefined as never), sources: [] });
		const { events } = await run("atualiza meu dashboard", [
			toolCall("page_read", { page_id: "page-1" }, "r1"),
			toolCall("page_update", { page_id: "page-1", title: "hack" }, "u1"),
			toolCall("page_list", {}, "l1"),
			say("não achei"),
		], store);
		expect(resultOf(events, "page_read")[0]).toMatchObject({ ok: false });
		expect(resultOf(events, "page_read")[0]!.summary).toMatch(/not found/);
		expect(resultOf(events, "page_update")[0]).toMatchObject({ ok: false });
		expect(resultOf(events, "page_list")[0]!.summary).toBe("This bot has no pages yet.");
		expect(rows[0]!.title).toBe("Forecast do trimestre");
		expect(rows[0]!.revision).toBe(1);
		expect(events.some((e) => e.type === "page")).toBe(false);
	});

	it("page_read lista os ids dos blocos e page_list os ids das páginas", async () => {
		const { store } = memoryStore();
		const { events } = await run("monta meu forecast do trimestre", [
			toolCall("page_create", forecast),
			toolCall("page_read", { page_id: "page-1" }, "r1"),
			toolCall("page_list", {}, "l1"),
			say("ok"),
		], store);
		const read = resultOf(events, "page_read")[0]!;
		expect(read.ok).toBe(true);
		expect(read.summary).toContain("- por-regiao [bar_list]");
		expect(resultOf(events, "page_list")[0]!.summary).toContain('page-1: "Forecast do trimestre"');
	});

	it("as fontes padrão vêm das notas de pesquisa do run quando o modelo não as passa", async () => {
		const { rows, store } = memoryStore();
		await run("monta meu forecast do trimestre", [
			toolCall("research_note", { sourceRef: "https://dados.example.com/vendas", findings: "Vendas do trimestre por região" }),
			toolCall("page_create", { title: forecast.title, root: forecast.root }),
			say("ok"),
		], store);
		expect(rows[0]!.sources).toEqual([{ title: "Vendas do trimestre por região", url: "https://dados.example.com/vendas" } satisfies PageSource]);
	});
});
