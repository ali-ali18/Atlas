import { describe, expect, it } from "vitest";
import {
	DELEGATE_MAX_TASKS,
	applySubagentEvent,
	SUBAGENT_ABSOLUTE_MAX_TOKENS,
	SUBAGENT_MIN_SCALED_TOKENS,
	scaledChildTokenBudget,
	SUBAGENT_WALL_MS,
	buildChildToolFilter,
	selectChildWebConnectorTools,
	formatDelegateResults,
	matchesToolPattern,
	mergeSubagentTasks,
	subagentLabel,
	subagentLookSeed,
	selectChildMcpPreactivation,
	parseDelegateTaskArgs,
	planChildBudget,
	readSubagentModel,
	resolveSubagentModel,
	withSubagentModel,
} from "./subagents.js";

describe("parseDelegateTaskArgs", () => {
	it("aceita 1 a 3 tarefas e apara o texto", () => {
		const parsed = parseDelegateTaskArgs({
			tasks: [{ goal: "  preço na Amazon ", context: " ctx ", tools: ["web_search", "web_search"] }],
		});
		expect(parsed).toEqual({
			ok: true,
			tasks: [{ goal: "preço na Amazon", context: "ctx", tools: ["web_search"] }],
		});
	});

	it("recusa vazio, mais de 3, goal vazio/enorme e tools inválidas", () => {
		expect(parseDelegateTaskArgs({}).ok).toBe(false);
		expect(parseDelegateTaskArgs({ tasks: [] }).ok).toBe(false);
		const four = Array.from({ length: DELEGATE_MAX_TASKS + 1 }, () => ({ goal: "x" }));
		expect(parseDelegateTaskArgs({ tasks: four })).toMatchObject({ ok: false });
		expect(parseDelegateTaskArgs({ tasks: [{ goal: "  " }] }).ok).toBe(false);
		expect(parseDelegateTaskArgs({ tasks: [{ goal: "x".repeat(2001) }] }).ok).toBe(false);
		expect(parseDelegateTaskArgs({ tasks: [{ goal: "x", tools: ["../etc"] }] }).ok).toBe(false);
		expect(parseDelegateTaskArgs({ tasks: [{ goal: "x", tools: "web_search" }] }).ok).toBe(false);
		expect(parseDelegateTaskArgs({ tasks: [{ goal: "x", context: 3 }] }).ok).toBe(false);
	});
});

describe("filtro de tools do filho", () => {
	const readOnly = new Map([
		["mcp__github__list_prs", true],
		["mcp__github__merge_pr", false],
		["mcp__slack__read", true],
	]);
	const filter = (requested?: string[]) =>
		buildChildToolFilter({
			requested,
			isMcpName: (name) => name.startsWith("mcp__"),
			isMcpReadOnly: (name) => readOnly.get(name),
		});

	it("research_note segue o filho mesmo quando o pai restringe as tools; a parede do filho é 12 min", () => {
		expect(filter(["mcp__github__"])("research_note")).toBe(true);
		expect(SUBAGENT_WALL_MS).toBe(12 * 60 * 1000);
	});

	it("padrão: leitura nativa + MCP read-only; nunca propose/delegate/sandbox/memory", () => {
		const f = filter();
		for (const ok of ["web_search", "web_extract", "memory_search", "session_search", "mcp__github__list_prs", "mcp__slack__read", "mcp_tool_search", "research_note"]) {
			expect(f(ok), ok).toBe(true);
		}
		for (const no of ["delegate_task", "propose_routine", "propose_profile_update", "navigate", "browser_click", "memory", "list_routines", "mcp__github__merge_pr", "mcp__desconhecida__x"]) {
			expect(f(no), no).toBe(false);
		}
	});

	it("prefixo restringe; pedir tool proibida não a libera", () => {
		const f = filter(["mcp__github__", "delegate_task", "mcp__github__merge_pr"]);
		expect(f("mcp__github__list_prs")).toBe(true);
		expect(f("mcp__slack__read")).toBe(false);
		expect(f("web_search")).toBe(false);
		expect(f("delegate_task")).toBe(false);
		expect(f("mcp__github__merge_pr")).toBe(false);
		expect(matchesToolPattern("web_search", ["web_"])).toBe(true);
	});
});

describe("filtro do filho com conector web (Firecrawl)", () => {
	const readOnly = new Map([
		["mcp__firecrawl__firecrawl_search", true],
		["mcp__firecrawl__firecrawl_scrape", true],
		["mcp__firecrawl__firecrawl_agent", false],
	]);
	const build = (requested?: string[], webConnectorTools?: string[]) =>
		buildChildToolFilter({
			requested,
			webConnectorTools,
			isMcpName: (name) => name.startsWith("mcp__"),
			isMcpReadOnly: (name) => readOnly.get(name),
		});
	const connector = selectChildWebConnectorTools([...readOnly].map(([name, ro]) => ({ name, readOnly: ro })));

	it("seleciona só search/scrape read-only do Firecrawl", () => {
		expect(connector.sort()).toEqual(["mcp__firecrawl__firecrawl_scrape", "mcp__firecrawl__firecrawl_search"]);
		expect(selectChildWebConnectorTools([{ name: "mcp__github__search_code", readOnly: true }])).toEqual([]);
	});

	it("com Firecrawl: web_search/web_extract continuam como reserva quando os créditos acabam (caso real)", () => {
		const f = build(undefined, connector);
		expect(f("web_search")).toBe(true);
		expect(f("web_extract")).toBe(true);
		expect(f("mcp__firecrawl__firecrawl_search")).toBe(true);
		expect(f("mcp__firecrawl__firecrawl_scrape")).toBe(true);
		expect(f("mcp__firecrawl__firecrawl_agent")).toBe(false);
		expect(f("memory_search")).toBe(true);
		// Restrição pedida pelo pai vale para as nativas, mas não tira o conector.
		const only = build(["web_search"], connector);
		expect(only("web_search")).toBe(true);
		expect(only("web_extract")).toBe(false);
		expect(only("mcp__firecrawl__firecrawl_scrape")).toBe(true);
	});

	it("sem Firecrawl: as nativas continuam", () => {
		const f = build(["web_search"], []);
		expect(f("web_search")).toBe(true);
		expect(f("web_extract")).toBe(false);
		expect(build(undefined, [])("web_extract")).toBe(true);
	});
});

describe("planChildBudget", () => {
	it("sem teto no pai e sem janela conhecida: base de 128k (piso)", () => {
		const plan = planChildBudget({ taskCount: 3 });
		expect(plan).toEqual({
			ok: true,
			budget: { softMaxSteps: 12, hardMaxSteps: 30, maxWallMs: SUBAGENT_WALL_MS, maxTokens: SUBAGENT_MIN_SCALED_TOKENS },
		});
		expect(planChildBudget({ taskCount: 1, childContextLength: null })).toMatchObject({ budget: { maxTokens: 400_000 } });
		expect(planChildBudget({ taskCount: 1, childContextLength: Number.NaN })).toMatchObject({ budget: { maxTokens: 400_000 } });
	});

	it("escala com a janela do modelo do filho (3x, piso 400k, teto 4M)", () => {
		expect(scaledChildTokenBudget(1_000_000)).toBe(3_000_000);
		expect(scaledChildTokenBudget(128_000)).toBe(400_000);
		expect(scaledChildTokenBudget(200_000)).toBe(600_000);
		expect(scaledChildTokenBudget(8_000_000)).toBe(SUBAGENT_ABSOLUTE_MAX_TOKENS);
		expect(planChildBudget({ taskCount: 2, childContextLength: 1_000_000 })).toMatchObject({ budget: { maxTokens: 3_000_000 } });
	});

	it("limita ao que sobra no pai dividido pelos filhos", () => {
		expect(planChildBudget({ taskCount: 3, childContextLength: 1_000_000, parentTokensRemaining: 6_000_000 })).toMatchObject({
			budget: { maxTokens: 2_000_000 },
		});
		expect(planChildBudget({ taskCount: 1, childContextLength: 1_000_000, parentTokensRemaining: 9_000_000 })).toMatchObject({
			budget: { maxTokens: 3_000_000 },
		});
		expect(planChildBudget({ taskCount: 3, childContextLength: 128_000, parentTokensRemaining: 90_000 })).toMatchObject({
			budget: { maxTokens: 30_000 },
		});
	});

	it("divide os tokens que sobram e limita o relógio ao do pai", () => {
		const plan = planChildBudget({ taskCount: 3, parentTokensRemaining: 300_000, parentWallRemainingMs: 3 * 60_000 });
		expect(plan).toMatchObject({ ok: true, budget: { maxTokens: 100_000, maxWallMs: 150_000 } });
	});

	it("recusa quando o pai não tem mais fôlego", () => {
		expect(planChildBudget({ taskCount: 3, parentTokensRemaining: 30_000 }).ok).toBe(false);
		expect(planChildBudget({ taskCount: 1, parentWallRemainingMs: 40_000 }).ok).toBe(false);
	});
});

describe("resultado para o pai", () => {
	it("mantém o relatório inteiro e marca dado não confiável", () => {
		const long = "a".repeat(5_000);
		expect(formatDelegateResults([{ taskIndex: 0, goal: "G", status: "ok", report: long, toolsUsed: [] }])).toContain(long);
		const text = formatDelegateResults([
			{ taskIndex: 0, goal: "Amazon", status: "ok", report: "R$ 1", toolsUsed: ["web_search"] },
			{ taskIndex: 1, goal: "Kabum", status: "failed", report: "sem acesso", toolsUsed: [] },
		]);
		expect(text).toContain("untrusted");
		expect(text).toContain("### Task 1 [ok]");
		expect(text).toContain("### Task 2 [failed]");
	});
});

describe("título dos subagentes", () => {
	it("parse apara, corta em 40 e ignora título vazio ou inválido", () => {
		const parsed = parseDelegateTaskArgs({
			tasks: [{ goal: "a", title: "  Amazon  " }, { goal: "b", title: "x".repeat(80) }, { goal: "c", title: "   " }],
		});
		if (!parsed.ok) throw new Error("parse");
		expect(parsed.tasks.map((t) => t.title)).toEqual(["Amazon", "x".repeat(40), undefined]);
	});

	it("subagentLabel usa o título; sem ele, a primeira frase do objetivo", () => {
		expect(subagentLabel({ title: " Kabum ", goal: "Buscar preço", taskIndex: 0 })).toBe("Kabum");
		expect(subagentLabel({ goal: "Buscar o preço do iPhone na Amazon. Depois compare frete.", taskIndex: 0 })).toBe(
			"Buscar o preço do iPhone na Amazon.",
		);
		expect(subagentLabel({ goal: "", taskIndex: 1 })).toBe("Tarefa 2");
	});

	it("subagentLabel corta frase longa em 60 com reticências", () => {
		const label = subagentLabel({ goal: "palavra ".repeat(30), taskIndex: 0 });
		expect(label.length).toBeLessThanOrEqual(60);
		expect(label.endsWith("…")).toBe(true);
	});

	it("título viaja do início ao fim e sobrevive ao merge", () => {
		let tasks = applySubagentEvent([], { type: "subagent_started", taskIndex: 0, goal: "A", title: "Amazon" });
		tasks = applySubagentEvent(tasks, { type: "subagent_done", taskIndex: 0, status: "ok", summary: "", toolsUsed: [] });
		expect(tasks[0]?.title).toBe("Amazon");
		const merged = mergeSubagentTasks(tasks, [{ taskIndex: 0, goal: "A", status: "ok", toolsUsed: [] }]);
		expect(merged[0]?.title).toBe("Amazon");
	});
});

describe("applySubagentEvent", () => {
	it("acompanha o ciclo de vida e é idempotente no replay", () => {
		let tasks = applySubagentEvent([], { type: "subagent_started", taskIndex: 1, goal: "Kabum" });
		tasks = applySubagentEvent(tasks, { type: "subagent_started", taskIndex: 0, goal: "Amazon" });
		tasks = applySubagentEvent(tasks, { type: "subagent_tool", taskIndex: 0, name: "web_search" });
		tasks = applySubagentEvent(tasks, { type: "subagent_tool", taskIndex: 0, name: "web_search" });
		expect(tasks.map((t) => [t.taskIndex, t.status, t.toolsUsed.length])).toEqual([
			[0, "running", 1],
			[1, "running", 0],
		]);
		const done = { type: "subagent_done" as const, taskIndex: 0, status: "ok" as const, summary: "R$ 1", toolsUsed: ["web_search"] };
		tasks = applySubagentEvent(tasks, done);
		const again = applySubagentEvent(tasks, done);
		expect(again).toEqual(tasks);
		expect(tasks[0]).toMatchObject({ goal: "Amazon", status: "ok", summary: "R$ 1" });
		expect(tasks[1]).toMatchObject({ status: "running" });
	});

	it("guarda o modelo no início e mantém depois do fim", () => {
		let tasks = applySubagentEvent([], { type: "subagent_started", taskIndex: 0, goal: "A", model: "x/m" });
		tasks = applySubagentEvent(tasks, { type: "subagent_done", taskIndex: 0, status: "ok", summary: "", toolsUsed: [] });
		expect(tasks[0]?.model).toBe("x/m");
	});
});

describe("modelo dos subagentes", () => {
	it("precedência: arg permitido > bot > pai", () => {
		const base = { requestAllowed: true, requestedKnown: true, parent: "p/pai", botSetting: "b/bot" };
		expect(resolveSubagentModel({ ...base, requested: "x/arg" })).toEqual({ model: "x/arg", source: "arg" });
		expect(resolveSubagentModel(base)).toEqual({ model: "b/bot", source: "bot" });
		expect(resolveSubagentModel({ ...base, botSetting: null })).toEqual({ model: "p/pai", source: "parent" });
	});

	it("ignora o arg sem pedido do usuário ou com id desconhecido, com nota", () => {
		const denied = resolveSubagentModel({
			requested: "x/arg", requestAllowed: false, requestedKnown: true, parent: "p/pai", botSetting: "b/bot",
		});
		expect(denied).toMatchObject({ model: "b/bot", source: "bot" });
		expect(denied.note).toMatch(/did not ask/);
		const unknown = resolveSubagentModel({
			requested: "x/nao-existe", requestAllowed: true, requestedKnown: false, parent: "p/pai",
		});
		expect(unknown).toMatchObject({ model: "p/pai", source: "parent" });
		expect(unknown.note).toMatch(/not an available/);
	});

	it("lê e grava a chave no policyJson preservando o resto", () => {
		expect(readSubagentModel(null)).toBeNull();
		expect(readSubagentModel({ subagentModel: " a/b " })).toBe("a/b");
		expect(withSubagentModel({ maxTokens: 5 }, "a/b")).toEqual({ maxTokens: 5, subagentModel: "a/b" });
		expect(withSubagentModel({ maxTokens: 5, subagentModel: "a/b" }, null)).toEqual({ maxTokens: 5 });
		expect(withSubagentModel(null, null)).toEqual({});
	});

	it("parseDelegateTaskArgs valida o model", () => {
		expect(parseDelegateTaskArgs({ tasks: [{ goal: "x" }], model: " a/b " })).toMatchObject({ ok: true, model: "a/b" });
		expect(parseDelegateTaskArgs({ tasks: [{ goal: "x" }], model: "a b; rm" }).ok).toBe(false);
		expect(parseDelegateTaskArgs({ tasks: [{ goal: "x" }], model: 3 }).ok).toBe(false);
	});
});

describe("mergeSubagentTasks", () => {
	const running = (taskIndex: number, goal = "") => ({ taskIndex, goal, status: "running" as const, toolsUsed: [] });
	const ok = (taskIndex: number, goal = "") => ({ taskIndex, goal, status: "ok" as const, summary: "feito", toolsUsed: ["web_search"] });

	it("une ao vivo + salvo em uma lista só, sem regredir concluído para pesquisando", () => {
		const merged = mergeSubagentTasks([ok(0, "A"), running(1, "B")], [running(0), ok(1)]);
		expect(merged).toHaveLength(2);
		expect(merged.map((t) => t.status)).toEqual(["ok", "ok"]);
		expect(merged[1]?.goal).toBe("B");
	});

	it("o merge mantém o modelo mesmo quando quem chega não traz", () => {
		const live = { ...ok(0, "A"), model: "x/m" };
		expect(mergeSubagentTasks([live], [ok(0, "A")])[0]?.model).toBe("x/m");
	});

	it("é idempotente e ordena por taskIndex", () => {
		const a = [ok(2, "C"), ok(0, "A")];
		const once = mergeSubagentTasks([], a);
		expect(once.map((t) => t.taskIndex)).toEqual([0, 2]);
		expect(mergeSubagentTasks(once, a)).toEqual(once);
	});
});

describe("subagentLookSeed", () => {
	it("é determinístico e varia por tarefa", () => {
		expect(subagentLookSeed("run-d1", 0)).toBe(subagentLookSeed("run-d1", 0));
		const seeds = new Set([0, 1, 2].map((i) => subagentLookSeed("run-d1", i)));
		expect(seeds.size).toBe(3);
		expect(subagentLookSeed("run-d2", 0)).not.toBe(subagentLookSeed("run-d1", 0));
		expect(Number.isInteger(subagentLookSeed("x", 0))).toBe(true);
	});
});

describe("selectChildMcpPreactivation", () => {
	const entries = [
		{ name: "mcp__firecrawl__firecrawl_search", readOnly: true },
		{ name: "mcp__firecrawl__firecrawl_scrape", readOnly: true },
		{ name: "mcp__firecrawl__firecrawl_agent", readOnly: true },
		{ name: "mcp__github__list_prs", readOnly: true },
		{ name: "mcp__github__create_issue", readOnly: false },
		{ name: "mcp__other__scrape_page", readOnly: true },
	];

	it("inclui as de leitura do pai e busca/scrape do Firecrawl", () => {
		expect(
			selectChildMcpPreactivation({ parentActive: ["mcp__github__list_prs"], entries }),
		).toEqual([
			"mcp__github__list_prs",
			"mcp__firecrawl__firecrawl_search",
			"mcp__firecrawl__firecrawl_scrape",
		]);
	});

	it("nunca inclui escrita, nem quando o pai a ativou", () => {
		const picked = selectChildMcpPreactivation({ parentActive: ["mcp__github__create_issue"], entries });
		expect(picked).not.toContain("mcp__github__create_issue");
	});

	it("sem Firecrawl conectado, só o que o pai já ativou", () => {
		expect(
			selectChildMcpPreactivation({
				parentActive: ["mcp__github__list_prs"],
				entries: entries.filter((e) => !e.name.includes("firecrawl")),
			}),
		).toEqual(["mcp__github__list_prs"]);
		expect(selectChildMcpPreactivation({ parentActive: [], entries: [] })).toEqual([]);
	});

	it("respeita o teto", () => {
		expect(selectChildMcpPreactivation({ parentActive: [], entries, max: 1 })).toHaveLength(1);
	});
});
