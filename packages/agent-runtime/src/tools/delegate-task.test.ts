import { describe, expect, it, vi } from "vitest";
import { BudgetExhaustedError } from "../errors.js";
import { buildMcpToolset } from "../mcp/registry.js";
import { P_DELEGATION, P_TAIL } from "../context/prompt-blocks.js";
import { SUBAGENT_SYSTEM_PROMPT } from "./subagent-prompt.js";
import { createResearchNotes } from "./research-note.js";
import {
	REDUCED_SCOPE_NOTE,
	executeDelegateTask,
	shouldExposeDelegateTask,
	type DelegateContext,
	type DelegateDeps,
} from "./delegate-task.js";

function makeCtx(overrides: Partial<DelegateContext> = {}) {
	const events: Array<{ type: string } & Record<string, unknown>> = [];
	const deps: DelegateDeps = {
		createChild: vi.fn(async () => ({ id: "child-1" })),
		finishChild: vi.fn(async () => true),
		failOrphans: vi.fn(async () => 0),
		appendStep: vi.fn(async () => undefined),
		saveCard: vi.fn(async () => ({}) as never),
	};
	const added: number[] = [];
	const ctx: DelegateContext = {
		parentRunId: "run-p",
		groupId: "run-p-d1",
		conversationId: "conv-1",
		userId: "user-1",
		origin: "chat",
		model: "m",
		mcp: null,
		emit: (event) => {
			events.push(event as never);
		},
		remaining: () => ({}),
		addUsage: (usage) => added.push(usage.totalTokens),
		runChild: async () => ({ text: "relatório" }),
		deps,
		...overrides,
	};
	return { ctx, deps, events, added };
}

describe("executeDelegateTask", () => {
	it("estouro de orçamento devolve o resumo final do filho como parcial e soma o uso no pai", async () => {
		const { ctx, deps, added } = makeCtx({
			runChild: async (input) => {
				input.onUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
				const error = new BudgetExhaustedError("limite de 30 passos esgotado");
				error.finalText = "Consegui só a Amazon.";
				throw error;
			},
		});
		const { summary } = await executeDelegateTask({ tasks: [{ goal: "lojas" }] }, ctx);
		expect(summary).toContain("[partial]");
		expect(summary).toContain("Consegui só a Amazon.");
		expect(added).toEqual([15]);
		expect(vi.mocked(deps.finishChild).mock.calls[0]?.[0]).toMatchObject({
			status: "budget_exhausted",
			userId: "user-1",
			usage: { totalTokens: 15 },
		});
	});

	it("grava o card compacto na conversa e marca os eventos com o groupId", async () => {
		const { ctx, deps, events } = makeCtx();
		await executeDelegateTask({ tasks: [{ goal: "A" }, { goal: "B" }] }, ctx);
		expect(deps.saveCard).toHaveBeenCalledTimes(1);
		const [conversationId, card] = vi.mocked(deps.saveCard).mock.calls[0] ?? [];
		expect(conversationId).toBe("conv-1");
		expect(card).toMatchObject({ kind: "subagents", groupId: "run-p-d1" });
		expect((card as { tasks: unknown[] }).tasks).toHaveLength(2);
		expect(events.filter((e) => e.groupId === "run-p-d1")).toHaveLength(4);
	});

	it("título curto vai nos eventos e no card; sem título nada é inventado", async () => {
		const { ctx, deps, events } = makeCtx();
		await executeDelegateTask({ tasks: [{ goal: "A", title: "Amazon" }, { goal: "B" }] }, ctx);
		const started = events.filter((e) => e.type === "subagent_started");
		expect(started.map((e) => e.title)).toEqual(["Amazon", undefined]);
		expect(events.filter((e) => e.type === "subagent_done").find((e) => e.title)?.title).toBe("Amazon");
		const card = vi.mocked(deps.saveCard).mock.calls[0]?.[1] as { tasks: Array<{ title?: string }> };
		expect(card.tasks.map((t) => t.title)).toEqual(["Amazon", undefined]);
	});

	it("pedido de tool que nenhum filho pode ter falha sem abrir run", async () => {
		const { ctx, deps } = makeCtx();
		await expect(
			executeDelegateTask({ tasks: [{ goal: "x", tools: ["propose_routine"] }] }, ctx),
		).rejects.toThrow(/All sub-agents failed/);
		expect(deps.createChild).not.toHaveBeenCalled();
	});

	it("pai sem orçamento sobrando recusa delegar (erro acionável)", async () => {
		const { ctx, deps } = makeCtx({ remaining: () => ({ tokens: 10_000 }) });
		await expect(executeDelegateTask({ tasks: [{ goal: "x" }] }, ctx)).rejects.toThrow(/token budget/);
		expect(deps.createChild).not.toHaveBeenCalled();
	});

	it("orçamento de tokens do filho acompanha a janela do modelo dele e fica no run", async () => {
		const seen: string[] = [];
		const { ctx, deps } = makeCtx({
			model: "anthropic/claude-sonnet-5.5",
			getModelContextLength: (id) => (seen.push(id), 1_000_000),
			remaining: () => ({ tokens: 20_000_000 }),
			runChild: async (child) => {
				expect(child.budget.maxTokens).toBe(3_000_000);
				expect(child.contextLength).toBe(1_000_000);
				return { text: "ok" };
			},
		});
		await executeDelegateTask({ tasks: [{ goal: "x" }] }, ctx);
		expect(seen).toEqual(["anthropic/claude-sonnet-5.5"]);
		expect(vi.mocked(deps.createChild).mock.calls[0]?.[0].budgetJson).toMatchObject({
			maxTokens: 3_000_000,
			contextLength: 1_000_000,
		});
	});

	it("modelo sem janela conhecida usa a base de 128k (400k)", async () => {
		const { ctx } = makeCtx({
			getModelContextLength: () => null,
			runChild: async (child) => {
				expect(child.budget.maxTokens).toBe(400_000);
				return { text: "ok" };
			},
		});
		await executeDelegateTask({ tasks: [{ goal: "x" }] }, ctx);
	});

	it("filho não delega e rotina não delega, mesmo com o contexto montado", async () => {
		for (const origin of ["subagent", "routine", "webhook"]) {
			const { ctx } = makeCtx({ origin });
			await expect(executeDelegateTask({ tasks: [{ goal: "x" }] }, ctx)).rejects.toThrow(/not available/);
			expect(shouldExposeDelegateTask(origin)).toBe(false);
		}
		expect(shouldExposeDelegateTask("chat")).toBe(true);
		await expect(executeDelegateTask({ tasks: [{ goal: "x" }] }, undefined)).rejects.toThrow(/not available/);
	});

	it("run pai inexistente ou de outro dono: filho não é aberto e a tarefa falha", async () => {
		const { ctx, deps } = makeCtx();
		vi.mocked(deps.createChild).mockResolvedValueOnce(null);
		await expect(executeDelegateTask({ tasks: [{ goal: "x" }] }, ctx)).rejects.toThrow(/All sub-agents failed/);
		expect(deps.finishChild).not.toHaveBeenCalled();
	});
});

describe("modelo do subagente", () => {
	const known = (id: string) => id === "google/gemini-2.5-flash";

	it("sem config e sem pedido: herda o modelo do pai e registra no run, evento e card", async () => {
		const { ctx, deps, events } = makeCtx();
		let childModel = "";
		ctx.runChild = async (input) => {
			childModel = input.model;
			return { text: "ok" };
		};
		await executeDelegateTask({ tasks: [{ goal: "A" }] }, ctx);
		expect(childModel).toBe("m");
		expect(vi.mocked(deps.createChild).mock.calls[0]?.[0]).toMatchObject({ model: "m" });
		expect(events.filter((e) => e.type === "subagent_started" || e.type === "subagent_done").map((e) => e.model)).toEqual(["m", "m"]);
		const card = vi.mocked(deps.saveCard).mock.calls[0]?.[1] as { tasks: Array<{ model?: string }> };
		expect(card.tasks[0]?.model).toBe("m");
	});

	it("config do bot vale sobre o pai", async () => {
		const { ctx, deps } = makeCtx({ botSubagentModel: "b/bot" });
		await executeDelegateTask({ tasks: [{ goal: "A" }] }, ctx);
		expect(vi.mocked(deps.createChild).mock.calls[0]?.[0]).toMatchObject({ model: "b/bot" });
	});

	it("arg vale sobre o bot quando o usuário pediu e o modelo existe", async () => {
		const { ctx, deps } = makeCtx({
			botSubagentModel: "b/bot",
			jevSubagentModelRequest: true,
			isKnownModel: known,
		});
		const { summary } = await executeDelegateTask({ tasks: [{ goal: "A" }], model: "google/gemini-2.5-flash" }, ctx);
		expect(vi.mocked(deps.createChild).mock.calls[0]?.[0]).toMatchObject({ model: "google/gemini-2.5-flash" });
		expect(summary).not.toContain("model arg ignored");
	});

	it("arg sem pedido do usuário é ignorado com nota", async () => {
		const { ctx, deps } = makeCtx({
			botSubagentModel: "b/bot",
			jevSubagentModelRequest: false,
			isKnownModel: known,
		});
		const { summary } = await executeDelegateTask({ tasks: [{ goal: "A" }], model: "google/gemini-2.5-flash" }, ctx);
		expect(vi.mocked(deps.createChild).mock.calls[0]?.[0]).toMatchObject({ model: "b/bot" });
		expect(summary).toContain("model arg ignored");
	});

	it("sem Jev (flag ausente) o arg model é ignorado, mesmo que o texto cite o modelo", async () => {
		const { ctx, deps } = makeCtx({ botSubagentModel: "b/bot", isKnownModel: known });
		const { summary } = await executeDelegateTask({ tasks: [{ goal: "A" }], model: "google/gemini-2.5-flash" }, ctx);
		expect(vi.mocked(deps.createChild).mock.calls[0]?.[0]).toMatchObject({ model: "b/bot" });
		expect(summary).toContain("model arg ignored");
	});

	it("arg com modelo inexistente é ignorado e cai no pai", async () => {
		const { ctx, deps } = makeCtx({
			jevSubagentModelRequest: true,
			isKnownModel: known,
		});
		const { summary } = await executeDelegateTask({ tasks: [{ goal: "A" }], model: "foo/bar" }, ctx);
		expect(vi.mocked(deps.createChild).mock.calls[0]?.[0]).toMatchObject({ model: "m" });
		expect(summary).toContain("not an available model id");
	});
});

describe("pré-ativação do Firecrawl no filho (catálogo adiado)", () => {
	const firecrawl = {
		id: "conn-fc",
		slug: "firecrawl",
		name: "Firecrawl",
		catalogId: "firecrawl",
		disabledTools: [],
		tools: ["firecrawl_scrape", "firecrawl_search", "firecrawl_agent", "firecrawl_monitor_create"].map(
			(name) => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } }),
		),
	};

	it("o filho recebe scrape/search reais (mcp__firecrawl__*) mesmo com o toolset adiado e pai sem tools ativas", async () => {
		const toolset = buildMcpToolset([firecrawl], {
			autonomy: { level: "autonomous", exceptions: [] },
			maxTools: 1,
		});
		expect(toolset.deferred).toBe(true);
		const runChild = vi.fn(async (_input: Parameters<DelegateContext["runChild"]>[0]) => ({ text: "ok" }));
		const { ctx } = makeCtx({
			mcp: { toolset, call: vi.fn() } as never,
			activeMcpTools: () => [],
			runChild,
		});
		await executeDelegateTask({ tasks: [{ goal: "preços no Mercado Livre" }] }, ctx);
		const input = runChild.mock.calls[0]?.[0];
		expect([...(input?.preactivateMcpTools ?? [])].sort()).toEqual([
			"mcp__firecrawl__firecrawl_scrape",
			"mcp__firecrawl__firecrawl_search",
		]);
		expect(input?.toolFilter("mcp__firecrawl__firecrawl_agent")).toBe(false);
	});

	it("o prompt do filho prefere conector web de forma genérica (JS, localização)", () => {
		expect(SUBAGENT_SYSTEM_PROMPT).toContain("you may use them for web work");
		expect(SUBAGENT_SYSTEM_PROMPT).toContain(
			"If a tool or connector fails because credits or quota ran out, do not retry it: switch to web_search and web_extract for the rest of the task and keep going.",
		);
		expect(SUBAGENT_SYSTEM_PROMPT).toMatch(/need JavaScript/);
		expect(SUBAGENT_SYSTEM_PROMPT).toMatch(/mcp_tool_search/);
	});

	it("o prompt do filho manda tentar um proxy mais forte uma vez só quando a loja bloqueia", () => {
		expect(SUBAGENT_SYSTEM_PROMPT).toMatch(/block page \(Cloudflare challenge/);
		expect(SUBAGENT_SYSTEM_PROMPT).toContain("stronger proxy option");
		expect(SUBAGENT_SYSTEM_PROMPT).toMatch(/ONCE/);
		expect(SUBAGENT_SYSTEM_PROMPT).toMatch(/only after a block/);
	});

	it("texto para o modelo é neutro: sem nome de conector (subagente, P_TAIL, delegação)", () => {
		expect(SUBAGENT_SYSTEM_PROMPT).not.toMatch(/firecrawl/i);
		expect(P_TAIL.join(" ")).not.toMatch(/firecrawl/i);
		expect(P_DELEGATION.join(" ")).not.toMatch(/firecrawl/i);
	});
});

describe("executeDelegateTask: uso dos filhos", () => {
	it("propaga cacheWriteTokens e a contagem de custo desconhecido para o pai", async () => {
		const usages: Array<Record<string, unknown>> = [];
		const { ctx } = makeCtx({
			addUsage: (usage) => usages.push(usage as never),
			runChild: async (input) => {
				input.onUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.01, cacheWriteTokens: 4 });
				input.onUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15, costUnknownCalls: 1, cacheWriteTokens: 6, cachedTokens: 3 });
				return { text: "ok" };
			},
		});
		await executeDelegateTask({ tasks: [{ goal: "A" }] }, ctx);
		expect(usages).toHaveLength(1);
		expect(usages[0]).toMatchObject({
			totalTokens: 30,
			costUsd: 0.01,
			costUnknownCalls: 1,
			cacheWriteTokens: 10,
			cachedTokens: 3,
		});
	});
});

it("filho preserva provedor do pai mesmo com preferência de outro provedor", async()=>{
 const runChild=vi.fn(async()=>({text:"report"}));
 const {ctx,deps}=makeCtx({model:"chatgpt/luna",botSubagentModel:"openai/gpt-6-luna",runChild});
 await executeDelegateTask({tasks:[{goal:"Read"}]},ctx);
 expect(runChild.mock.calls[0]?.[0]).toMatchObject({model:"chatgpt/luna"});
 expect(deps.createChild).toHaveBeenCalledWith(expect.objectContaining({model:"chatgpt/luna"}));
});

describe("F4: notas de pesquisa dos filhos", () => {
	const note = (n: number) => ({
		sourceRef: `https://example.test/f${n}`,
		findings: `finding ${n}`,
		keyFacts: [`fact ${n}`],
		links: [],
		confidence: "high" as const,
		step: n,
	});

	it("o relatório do filho inclui as notas e o pai as recebe na camada dele", async () => {
		const parentNotes = createResearchNotes();
		const { ctx } = makeCtx({
			researchNotes: parentNotes,
			runChild: async (child) => {
				child.researchNotes.add(note(1));
				return { text: "Relatório do filho." };
			},
		});
		const { summary } = await executeDelegateTask({ tasks: [{ goal: "pesquisar" }] }, ctx);
		expect(summary).toContain("Relatório do filho.");
		expect(summary).toContain("Research notes from this sub-agent");
		expect(summary).toContain("https://example.test/f1: finding 1");
		expect(parentNotes.snapshot().map((item) => item.sourceRef)).toEqual(["https://example.test/f1"]);
	});

	it("prazo estourado com achados vira relatório parcial com as notas (não failed)", async () => {
		const { ctx, deps } = makeCtx({
			runChild: async (child) => {
				child.researchNotes.add(note(2));
				child.onEvent({ type: "assistant_delta", id: "m1", delta: "Achei o preço X." });
				throw new DOMException("Decision deadline exceeded", "TimeoutError");
			},
		});
		const { summary } = await executeDelegateTask({ tasks: [{ goal: "pesquisar" }] }, ctx);
		expect(summary).toContain("[partial]");
		expect(summary).toContain("Achei o preço X.");
		expect(summary).toContain("finding 2");
		expect(vi.mocked(deps.finishChild).mock.calls[0]?.[0]).toMatchObject({ status: "budget_exhausted" });
	});

	it("filho que estoura o prazo sem achado tenta uma vez com escopo reduzido", async () => {
		const goals: string[] = [];
		const { ctx, deps } = makeCtx({
			runChild: async (child) => {
				goals.push(child.messages[0]!.content);
				if (goals.length === 1) throw new DOMException("Decision deadline exceeded", "TimeoutError");
				return { text: "Resposta curta." };
			},
		});
		const { summary } = await executeDelegateTask({ tasks: [{ goal: "pesquisar tudo" }] }, ctx);
		expect(goals).toHaveLength(2);
		expect(goals[1]).toContain(REDUCED_SCOPE_NOTE);
		expect(summary).toContain("Resposta curta.");
		expect(vi.mocked(deps.createChild)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(deps.finishChild).mock.calls.map((call) => call[0].status)).toEqual(["failed", "completed"]);
	});

	it("o retry é um só: segundo prazo estourado fica failed", async () => {
		const { ctx, deps } = makeCtx({
			runChild: async () => {
				throw new DOMException("Decision deadline exceeded", "TimeoutError");
			},
		});
		await expect(executeDelegateTask({ tasks: [{ goal: "x" }] }, ctx)).rejects.toThrow(/All sub-agents failed/);
		expect(vi.mocked(deps.createChild)).toHaveBeenCalledTimes(2);
	});

	it("erro que não é prazo não é repetido", async () => {
		const { ctx, deps } = makeCtx({
			runChild: async () => {
				throw new Error("provider exploded");
			},
		});
		await expect(executeDelegateTask({ tasks: [{ goal: "x" }] }, ctx)).rejects.toThrow(/All sub-agents failed/);
		expect(vi.mocked(deps.createChild)).toHaveBeenCalledTimes(1);
	});

	it("o prompt do filho manda registrar notas", () => {
		expect(SUBAGENT_SYSTEM_PROMPT).toContain("research_note");
	});
});

describe("V2: delegação cega (sub-agente sem a sessão do navegador)", () => {
	const urlTask = { tasks: [{ goal: "Open https://site.example/course/1 and summarize it" }] };

	it("pai que já trabalha no navegador não delega leitura de URL: erro imediato com a dica", async () => {
		const { ctx, deps } = makeCtx({ parentBrowserActive: () => true });
		await expect(executeDelegateTask(urlTask, ctx)).rejects.toThrow(/Sub-agents cannot use your browser session/);
		expect(deps.createChild).not.toHaveBeenCalled();
	});

	it("sem uso do navegador no run, a URL pública ainda pode ser delegada", async () => {
		const { ctx, deps } = makeCtx({ parentBrowserActive: () => false });
		await executeDelegateTask(urlTask, ctx);
		expect(deps.createChild).toHaveBeenCalledTimes(1);
	});

	it("filho em que toda tool falhou volta como failed (não como conteúdo), mesmo com relatório 'ok'", async () => {
		const { ctx, deps } = makeCtx({
			runChild: async (input) => {
				if (input.objective.includes("good")) {
					await input.onEvent({ type: "tool_result", id: "t0", name: "web_search", ok: true, summary: "found" });
					return { text: "Found the answer." };
				}
				await input.onEvent({ type: "tool_result", id: "t1", name: "web_extract", ok: false, summary: "404" });
				await input.onEvent({ type: "tool_result", id: "t2", name: "web_extract", ok: false, summary: "402" });
				return { text: "I could not open the page." };
			},
		});
		const { summary } = await executeDelegateTask({ tasks: [{ goal: "good" }, { goal: "bad page" }] }, ctx);
		expect(summary).toContain("[ok]");
		expect(summary).toContain("[failed]");
		expect(summary).toContain("This is not a finding");
		expect(summary).not.toContain("I could not open the page.");
		const statuses = vi.mocked(deps.finishChild).mock.calls.map(([arg]) => arg.status);
		expect(statuses).toContain("failed");
	});

	it("depois de um filho cego falhar com o pai no navegador, não delega de novo", async () => {
		const blindState = { failed: false };
		const failing = {
			parentBrowserActive: () => true,
			blindState,
			runChild: async (input: Parameters<DelegateContext["runChild"]>[0]) => {
				await input.onEvent({ type: "tool_result", id: "t1", name: "web_extract", ok: false, summary: "404" });
				return { text: "could not open" };
			},
		};
		const first = makeCtx(failing);
		await expect(executeDelegateTask({ tasks: [{ goal: "read the item" }] }, first.ctx)).rejects.toThrow(/All sub-agents failed/);
		expect(blindState.failed).toBe(true);
		const second = makeCtx({ ...failing });
		await expect(executeDelegateTask({ tasks: [{ goal: "read another item" }] }, second.ctx)).rejects.toThrow(/Do not delegate it again/);
		expect(second.deps.createChild).not.toHaveBeenCalled();
	});
});
