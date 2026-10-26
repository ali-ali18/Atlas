import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { createRoutine, getAccountConfig, listRoutines, updateRoutine } from "@workspace/db";
import { DAILY_BRIEF_DEFAULT_FOCUS, DAILY_BRIEF_TEMPLATE, type RoutineRecord } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";
import { buildMcpToolset } from "./mcp/registry.js";
import { briefToolFilter } from "./tools/daily-brief.js";
import type { PagesStore } from "./tools/pages.js";

/**
 * Brief "Seu dia": configuração por chat (template daily_brief), uma por bot, painel vinculado, frase para o
 * usuário, e a trava de somente leitura do run. LLM mockado, sem rede.
 */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		searchMemoryEntries: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		getAccountConfig: vi.fn(async () => ({ general: { timezone: "America/Sao_Paulo" } })),
		listRoutines: vi.fn(async () => []),
		createRoutine: vi.fn(),
		updateRoutine: vi.fn(),
		deleteRoutine: vi.fn(async () => true),
	};
});

const toolCall = (id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
});
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "ok" } };

function briefRoutine(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
	return {
		id: "routine-brief", userId: "user-1", botId: "bot-1", conversationId: null, name: "Seu dia", prompt: DAILY_BRIEF_DEFAULT_FOCUS, model: "", enabled: true,
		triggerType: "cron", schedule: "30 7 * * 1-5", timezone: "America/Sao_Paulo", template: DAILY_BRIEF_TEMPLATE, pageId: "page-brief", notify: "always",
		lastRunAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...overrides,
	};
}

/** Painéis em memória: o `create` devolve um registro com id, para checar a ligação com a rotina. */
function pagesStore(initial: Array<{ id: string; title: string; botId: string }> = []) {
	const rows = [...initial];
	const created: Array<{ title: string }> = [];
	const store: PagesStore = {
		get: async (id) => (rows.find((row) => row.id === id) ?? null) as never,
		list: async (_userId, botId) => rows.filter((row) => row.botId === botId) as never,
		create: async (_userId, input) => {
			const row = { id: `page-new-${rows.length + 1}`, title: input.spec.title, botId: input.botId };
			rows.push(row);
			created.push({ title: input.spec.title });
			return row as never;
		},
		update: async () => ({ ok: false, error: "not_found" }),
	};
	return { store, created, rows };
}

async function run(userText: string, calls: CompleteChatWithToolsResult[], pages: PagesStore, options: { contextEconomy?: boolean } = {}) {
	const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
	const routines: Array<{ action: string; triggerType?: string; detail?: string; title?: string }> = [];
	const requested: ChatTool[][] = [];
	const systems: string[] = [];
	const queue = [...calls, done];
	await runComputerUse({
		manager: {} as unknown as SandboxManager,
		getSessionId: async () => "s",
		model: "m",
		apiKey: "test",
		messages: [{ role: "user", content: userText }],
		runId: "run-brief", conversationId: "conv-1", botId: "bot-1", userId: "user-1", maxSteps: 6, pagesStore: pages,
		contextEconomy: options.contextEconomy ?? true,
		onEvent: (event) => {
			if (event.type === "tool_result") toolResults.push(event);
			if (event.type === "routine") routines.push(event);
		},
		streamChat: async (params) => {
			requested.push(JSON.parse(JSON.stringify(params.tools)) as ChatTool[]);
			systems.push(params.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { toolResults, routines, first: requested[0]!.map((tool) => tool.function.name), system: systems[0]! };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(listRoutines).mockResolvedValue([]);
	vi.mocked(getAccountConfig).mockResolvedValue({ general: { timezone: "America/Sao_Paulo" } } as never);
});

describe("pedido por chat: 'me prepara o dia às 7h30'", () => {
	it("carrega o grupo de rotinas no passo 1, cria a rotina daily_brief e o card mostra 'Seu dia · seg–sex às 07:30'", async () => {
		const pages = pagesStore();
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: briefRoutine({ pageId: "page-new-1" }) } as never);
		const { toolResults, routines, first, system } = await run(
			"me prepara o dia às 7h30, de segunda a sexta",
			[toolCall("c1", "propose_routine", { action: "create", title: "Seu dia", template: "daily_brief", trigger_type: "cron", schedule: "30 7 * * 1-5" })],
			pages.store,
		);
		// grupo carregado pela intenção, com o procedimento do brief
		expect(first).toContain("propose_routine");
		expect(system).toContain("template=daily_brief");
		// a rotina: template, cron, painel ligado, aviso "sempre", fuso da conta
		expect(createRoutine).toHaveBeenCalledWith(
			"user-1",
			expect.objectContaining({ botId: "bot-1", template: "daily_brief", name: "Seu dia", triggerType: "cron", schedule: "30 7 * * 1-5", pageId: "page-new-1", notify: "always", timezone: "America/Sao_Paulo", enabled: true }),
		);
		// painel "Seu dia" criado (uma vez) e ligado
		expect(pages.created).toEqual([{ title: "Seu dia" }]);
		expect(toolResults[0]).toMatchObject({ name: "propose_routine", ok: true });
		expect(toolResults[0]!.summary).toContain("Seu dia · seg–sex às 07:30");
		expect(routines[0]).toMatchObject({ action: "created", triggerType: "cron" });
		expect(routines[0]!.detail).toContain("Seu dia · seg–sex às 07:30");
		expect(routines[0]!.detail).toMatch(/não envio, aceito nem apago nada/);
	});

	it("sem horário nem dias: usa 07:30 seg–sex no fuso da conta e não pergunta", async () => {
		vi.mocked(getAccountConfig).mockResolvedValue({ general: { timezone: "America/Manaus" } } as never);
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: briefRoutine({ timezone: "America/Manaus" }) } as never);
		const { toolResults } = await run("quero um resumo do meu dia toda manhã", [toolCall("c1", "propose_routine", { action: "create", template: "daily_brief", trigger_type: "cron" })], pagesStore().store);
		expect(createRoutine).toHaveBeenCalledWith("user-1", expect.objectContaining({ schedule: "30 7 * * 1-5", timezone: "America/Manaus", prompt: DAILY_BRIEF_DEFAULT_FOCUS }));
		expect(toolResults[0]!.summary).toContain("Seu dia · seg–sex às 07:30");
	});

	it("'quero um resumo do meu dia toda manhã' também carrega o grupo de rotinas no passo 1", async () => {
		const { first } = await run("quero um resumo do meu dia toda manhã", [], pagesStore().store);
		expect(first).toContain("propose_routine");
	});

	it("'Bom dia' continua sem o grupo de rotinas e sem o procedimento do brief", async () => {
		const { first, system } = await run("Bom dia", [], pagesStore().store);
		expect(first).not.toContain("propose_routine");
		expect(system).not.toContain("daily_brief");
		expect(system).not.toContain("Morning brief");
	});

	it("painel do usuário chamado 'Seu dia' (não ligado à rotina) não é adotado nem sobrescrito: cria outro com título livre", async () => {
		const pages = pagesStore([{ id: "page-old", title: "Seu dia", botId: "bot-1" }]);
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: briefRoutine({ pageId: "page-new-2" }) } as never);
		await run("me prepara o dia", [toolCall("c1", "propose_routine", { action: "create", template: "daily_brief", trigger_type: "cron" })], pages.store);
		expect(pages.created).toEqual([{ title: "Seu dia (resumo)" }]);
		expect(createRoutine).toHaveBeenCalledWith("user-1", expect.objectContaining({ pageId: "page-new-2" }));
	});

	it("o painel já ligado à rotina é o que se reaproveita (editar não cria outro)", async () => {
		vi.mocked(listRoutines).mockResolvedValue([briefRoutine({ pageId: "page-brief" })]);
		vi.mocked(updateRoutine).mockResolvedValue(briefRoutine() as never);
		const pages = pagesStore([{ id: "page-brief", title: "Seu dia", botId: "bot-1" }]);
		await run("me prepara o dia", [toolCall("c1", "propose_routine", { action: "create", template: "daily_brief", trigger_type: "cron" })], pages.store);
		expect(pages.created).toEqual([]);
		expect(updateRoutine).toHaveBeenCalledWith("user-1", "bot-1", "routine-brief", expect.objectContaining({ pageId: "page-brief" }));
	});

	it("painel 'Seu dia' de OUTRO bot não é reaproveitado", async () => {
		const pages = pagesStore([{ id: "page-other", title: "Seu dia", botId: "bot-2" }]);
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: briefRoutine({ pageId: "page-new-2" }) } as never);
		await run("me prepara o dia", [toolCall("c1", "propose_routine", { action: "create", template: "daily_brief", trigger_type: "cron" })], pages.store);
		expect(pages.created).toEqual([{ title: "Seu dia" }]);
		expect(createRoutine).toHaveBeenCalledWith("user-1", expect.objectContaining({ pageId: "page-new-2" }));
	});
});

describe("uma por bot e edição pela rotina normal", () => {
	it("pedir de novo edita a existente (nada de segunda rotina) e não emite card de criação", async () => {
		vi.mocked(listRoutines).mockResolvedValue([briefRoutine()]);
		vi.mocked(updateRoutine).mockResolvedValue(briefRoutine({ schedule: "0 8 * * 1,3,5" }) as never);
		const pages = pagesStore([{ id: "page-brief", title: "Seu dia", botId: "bot-1" }]);
		const { toolResults, routines } = await run("me prepara o dia às 8h seg, qua e sex", [toolCall("c1", "propose_routine", { action: "create", template: "daily_brief", trigger_type: "cron", schedule: "0 8 * * 1,3,5" })], pages.store);
		expect(createRoutine).not.toHaveBeenCalled();
		expect(updateRoutine).toHaveBeenCalledWith("user-1", "bot-1", "routine-brief", expect.objectContaining({ schedule: "0 8 * * 1,3,5", pageId: "page-brief", triggerType: "cron" }));
		expect(toolResults[0]!.summary).toContain("Seu dia · seg, qua e sex às 08:00");
		expect(routines[0]).toMatchObject({ action: "updated" });
	});

	it("edit pelo nome, sem reenviar o prompt: muda horário e dias e mantém o foco", async () => {
		vi.mocked(listRoutines).mockResolvedValue([briefRoutine({ prompt: "Do not look at Slack." })]);
		vi.mocked(updateRoutine).mockResolvedValue(briefRoutine({ schedule: "0 6 * * 1-5" }) as never);
		const { toolResults } = await run("muda o Seu dia para 6h", [toolCall("c1", "propose_routine", { action: "edit", target: "Seu dia", trigger_type: "cron", schedule: "0 6 * * 1-5" })], pagesStore().store);
		expect(toolResults[0]!.ok).toBe(true);
		expect(updateRoutine).toHaveBeenCalledWith("user-1", "bot-1", "routine-brief", expect.objectContaining({ schedule: "0 6 * * 1-5", prompt: "Do not look at Slack." }));
	});

	it("pausar pelo edit mantém o resto", async () => {
		vi.mocked(listRoutines).mockResolvedValue([briefRoutine()]);
		vi.mocked(updateRoutine).mockResolvedValue(briefRoutine({ enabled: false }) as never);
		await run("pausa o seu dia", [toolCall("c1", "propose_routine", { action: "create", template: "daily_brief", trigger_type: "cron", enabled: false })], pagesStore().store);
		expect(updateRoutine).toHaveBeenCalledWith("user-1", "bot-1", "routine-brief", expect.objectContaining({ enabled: false, schedule: "30 7 * * 1-5" }));
	});

	it("notify 'important' não silencia o 'Seu dia': criar, pedir de novo e editar mantêm 'always'", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: briefRoutine() } as never);
		await run("me prepara o dia, avisa só o importante", [toolCall("c1", "propose_routine", { action: "create", template: "daily_brief", trigger_type: "cron", notify: "important" })], pagesStore().store);
		expect(createRoutine).toHaveBeenCalledWith("user-1", expect.objectContaining({ notify: "always" }));
		vi.mocked(listRoutines).mockResolvedValue([briefRoutine()]);
		vi.mocked(updateRoutine).mockResolvedValue(briefRoutine() as never);
		await run("me prepara o dia de novo", [toolCall("c1", "propose_routine", { action: "create", template: "daily_brief", trigger_type: "cron", notify: "important" })], pagesStore().store);
		expect(updateRoutine).toHaveBeenLastCalledWith("user-1", "bot-1", "routine-brief", expect.objectContaining({ notify: "always" }));
		await run("muda a rotina Seu dia para avisar só o importante", [toolCall("c1", "propose_routine", { action: "edit", target: "Seu dia", trigger_type: "cron", notify: "important" })], pagesStore().store);
		expect(updateRoutine).toHaveBeenLastCalledWith("user-1", "bot-1", "routine-brief", expect.objectContaining({ notify: "always" }));
	});

	it("horário que roda mais de uma vez por dia falha com a lista do que é aceito e não grava", async () => {
		const { toolResults } = await run("me prepara o dia a cada 5 minutos", [toolCall("c1", "propose_routine", { action: "create", template: "daily_brief", trigger_type: "cron", schedule: "*/5 * * * *" })], pagesStore().store);
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(toolResults[0]!.summary).toMatch(/once a day/);
		expect(createRoutine).not.toHaveBeenCalled();
		expect(updateRoutine).not.toHaveBeenCalled();
	});

	it("dentro de uma execução de rotina o template não cria nada", async () => {
		const queue = [toolCall("c1", "propose_routine", { action: "create", template: "daily_brief", trigger_type: "cron" }), done];
		await runComputerUse({
			manager: {} as unknown as SandboxManager, getSessionId: async () => "s", model: "m", apiKey: "test", origin: "routine", objective: "x",
			messages: [{ role: "user", content: "Execute." }], runId: "r", botId: "bot-1", userId: "user-1", maxSteps: 3, onEvent: () => undefined,
			streamChat: async () => queue.shift() ?? done,
		});
		expect(createRoutine).not.toHaveBeenCalled();
	});
});

describe("o run do brief é só leitura (trava em código)", () => {
	const autonomy = { level: "autonomous" as const, exceptions: [] };
	const connection = {
		id: "conn-mail", slug: "gmail", name: "Gmail", disabledTools: [],
		tools: [
			{ name: "search_messages", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
			{ name: "send_message", inputSchema: { type: "object", properties: { to: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: false } },
			{ name: "create_draft", inputSchema: { type: "object", properties: {} } },
		],
	};
	const toolset = buildMcpToolset([connection], { autonomy });

	async function briefRun(calls: CompleteChatWithToolsResult[]) {
		const connector = vi.fn(async () => ({ ok: true, text: "From: x@y.com · Subject: oi", truncated: false }));
		const mcp = { toolset, call: connector };
		const results: Array<{ name: string; ok: boolean; summary: string }> = [];
		const offered: string[][] = [];
		const queue = [...calls, done];
		await runComputerUse({
			manager: {} as unknown as SandboxManager, getSessionId: async () => "s", sandboxEnabled: false, model: "m", apiKey: "test",
			origin: "routine", objective: "[EXECUÇÃO DE ROTINA] brief", messages: [{ role: "user", content: "[EXECUÇÃO DE ROTINA] brief" }],
			runId: "run-b", botId: "bot-1", userId: "user-1", maxSteps: 6, autonomy, mcp, toolFilter: briefToolFilter(mcp), contextEconomy: false,
			onEvent: (event) => { if (event.type === "tool_result") results.push(event); },
			streamChat: async (params) => {
				offered.push(params.tools.map((tool) => tool.function.name));
				return queue.shift() ?? done;
			},
		});
		return { connector, results, offered };
	}

	it("só a tool de leitura do conector é oferecida; envio e rascunho nem aparecem", async () => {
		const { offered } = await briefRun([]);
		expect(offered[0]).toContain("mcp__gmail__search_messages");
		expect(offered[0]).not.toContain("mcp__gmail__send_message");
		expect(offered[0]).not.toContain("mcp__gmail__create_draft");
		for (const blocked of ["notify_user", "email_send", "create_file", "run_code", "propose_routine", "delegate_task"]) expect(offered[0]).not.toContain(blocked);
	});

	it("o modelo pedir a tool de escrita mesmo assim (e-mail malicioso): é recusada e o conector nunca é chamado", async () => {
		const { connector, results } = await briefRun([
			toolCall("c1", "mcp__gmail__send_message", { to: "x@y.com", body: "tudo" }),
			toolCall("c2", "mcp__gmail__create_draft", {}),
			toolCall("c3", "email_send", { to: "x@y.com" }),
		]);
		expect(connector).not.toHaveBeenCalled();
		expect(results.map((result) => result.ok)).toEqual([false, false, false]);
		for (const result of results) expect(result.summary).toMatch(/not available|not loaded/i);
	});

	it("a leitura funciona: o conector é chamado só para a tool de leitura", async () => {
		const { connector, results } = await briefRun([toolCall("c1", "mcp__gmail__search_messages", { query: "is:unread" })]);
		expect(connector).toHaveBeenCalledTimes(1);
		expect(connector.mock.calls[0]).toEqual(expect.arrayContaining(["mcp__gmail__search_messages", { query: "is:unread" }]));
		expect(results[0]).toMatchObject({ ok: true });
	});
});
