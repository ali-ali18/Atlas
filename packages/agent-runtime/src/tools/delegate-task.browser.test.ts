import { describe, expect, it, vi } from "vitest";
import { BROWSER_CHILD_HARD_STEPS, BROWSER_CHILD_WALL_MS, createConcurrencyLimiter, createTaskLedger, setLedgerItems, type TaskLedger } from "@workspace/shared";
import {
	BLIND_DELEGATION_HINT,
	BLIND_DELEGATION_HINT_BROWSER,
	DELEGATE_TASK_BROWSER_TOOL,
	DELEGATE_TASK_TOOL,
	executeDelegateTask,
	type BrowserDelegation,
	type ChildRunInput,
	type DelegateContext,
	type DelegateDeps,
} from "./delegate-task.js";
import { AgentRunCancelledError } from "../errors.js";
import { createResearchNotes } from "./research-note.js";
import { browserSubagentsEnabled } from "../execution/flag.js";
import type { LedgerStore } from "./track-items.js";

/** V8 — o executor do delegate_task em modo browser_item, sem LLM nem sandbox. */

function fakeTabs(max = 3) {
	const log = { opened: [] as Array<{ tabId: string; url?: string }>, closed: [] as string[], peak: 0, failOpen: undefined as undefined | string };
	const open = new Set<string>();
	let seq = 0;
	const browser: BrowserDelegation = {
		limiter: createConcurrencyLimiter(max),
		openTab: async (url) => {
			if (log.failOpen) throw new Error(log.failOpen);
			const tabId = `t${++seq}`;
			log.opened.push({ tabId, url });
			open.add(tabId);
			log.peak = Math.max(log.peak, open.size);
			return tabId;
		},
		closeTab: async (tabId) => {
			log.closed.push(tabId);
			open.delete(tabId);
		},
	};
	return { browser, log, open };
}

function ledgerStore(initial?: TaskLedger): LedgerStore & { current: () => TaskLedger | undefined } {
	let value = initial;
	return { get: () => value, set: (next) => { value = next; }, current: () => value };
}

const threeItems = () => setLedgerItems(createTaskLedger(), [{ id: "e1", label: "A" }, { id: "e2", label: "B" }, { id: "e3", label: "C" }]);

function makeCtx(overrides: Partial<DelegateContext> = {}) {
	const deps: DelegateDeps = {
		createChild: vi.fn(async () => ({ id: "child" })),
		finishChild: vi.fn(async () => true),
		failOrphans: vi.fn(async () => 0),
		appendStep: vi.fn(async () => undefined),
		saveCard: vi.fn(async () => ({}) as never),
	};
	const usage = { tokens: 0, cost: 0 };
	const ctx: DelegateContext = {
		parentRunId: "run-p",
		groupId: "run-p-d1",
		userId: "user-1",
		origin: "chat",
		model: "m",
		mcp: null,
		emit: () => undefined,
		remaining: () => ({}),
		addUsage: (u) => {
			usage.tokens += u.totalTokens;
			usage.cost += u.costUsd ?? 0;
		},
		runChild: async () => ({ text: "report" }),
		researchNotes: createResearchNotes(),
		deps,
		...overrides,
	};
	return { ctx, deps, usage };
}

const browserTask = (item: string, url = `https://lms.test/${item}`) => ({ goal: `Read ${item}`, item, url });
const args = (...tasks: Array<ReturnType<typeof browserTask>>) => ({ mode: "browser_item", tasks });

describe("delegate_task browser_item: abas", () => {
	it("cada filho recebe a SUA aba (id e url) e a aba é fechada ao fim", async () => {
		const tabs = fakeTabs();
		const received: Array<{ goal: string; tab?: string; message: string }> = [];
		const { ctx } = makeCtx({
			browser: tabs.browser,
			runChild: async (input: ChildRunInput) => {
				received.push({ goal: input.objective, tab: input.browserTabId, message: input.messages[0]!.content });
				return { text: "ok" };
			},
		});
		await executeDelegateTask(args(browserTask("e1"), browserTask("e2")), ctx);
		expect(tabs.log.opened).toEqual([{ tabId: "t1", url: "https://lms.test/e1" }, { tabId: "t2", url: "https://lms.test/e2" }]);
		const byGoal = Object.fromEntries(received.map((r) => [r.goal, r.tab]));
		expect(byGoal).toEqual({ "Read e1": "t1", "Read e2": "t2" });
		expect(received[0]!.message).toContain("Your tab is already open on: https://lms.test/e1");
		expect(tabs.log.closed.sort()).toEqual(["t1", "t2"]);
	});

	it("orçamento do filho fica no teto de navegador (passos e relógio)", async () => {
		const tabs = fakeTabs();
		let budget: ChildRunInput["budget"] | undefined;
		const { ctx } = makeCtx({ browser: tabs.browser, runChild: async (input) => ((budget = input.budget), { text: "ok" }) });
		await executeDelegateTask(args(browserTask("e1")), ctx);
		expect(budget?.hardMaxSteps).toBe(BROWSER_CHILD_HARD_STEPS);
		expect(budget?.maxWallMs).toBe(BROWSER_CHILD_WALL_MS);
	});

	it("teto de concorrência vale entre chamadas simultâneas: nunca mais de 3 abas abertas", async () => {
		const tabs = fakeTabs(3);
		const { ctx } = makeCtx({
			browser: tabs.browser,
			runChild: async () => {
				await new Promise((resolve) => setTimeout(resolve, 15));
				return { text: "ok" };
			},
		});
		await Promise.all([
			executeDelegateTask(args(browserTask("e1"), browserTask("e2"), browserTask("e3")), ctx),
			executeDelegateTask(args(browserTask("e4"), browserTask("e5")), ctx),
		]);
		expect(tabs.log.opened).toHaveLength(5);
		expect(tabs.log.peak).toBe(3);
		expect(tabs.log.closed).toHaveLength(5);
	});

	it("fecha a aba quando o filho falha e quando o run é cancelado", async () => {
		const failing = fakeTabs();
		const { ctx: failCtx } = makeCtx({ browser: failing.browser, runChild: async () => { throw new Error("boom"); } });
		await expect(executeDelegateTask(args(browserTask("e1")), failCtx)).rejects.toThrow(/All sub-agents failed/);
		expect(failing.log.closed).toEqual(["t1"]);

		const cancelled = fakeTabs();
		const { ctx: cancelCtx } = makeCtx({ browser: cancelled.browser, runChild: async () => { throw new AgentRunCancelledError(); } });
		await expect(executeDelegateTask(args(browserTask("e1"), browserTask("e2")), cancelCtx)).rejects.toBeInstanceOf(AgentRunCancelledError);
		expect(cancelled.log.closed.sort()).toEqual(["t1", "t2"]);
		expect(cancelled.open.size).toBe(0);
	});

	it("o limitador é liberado mesmo com falha: a fila seguinte anda", async () => {
		const tabs = fakeTabs(1);
		const { ctx } = makeCtx({ browser: tabs.browser, runChild: async (input) => { if (input.objective.includes("e1")) throw new Error("boom"); return { text: "ok" }; } });
		const { summary } = await executeDelegateTask(args(browserTask("e1"), browserTask("e2")), ctx);
		expect(summary).toContain("[failed]");
		expect(summary).toContain("[ok]");
		expect(tabs.browser.limiter.active()).toBe(0);
	});

	it("aba que não abre vira falha do item com o erro, sem rodar o filho", async () => {
		const tabs = fakeTabs();
		tabs.log.failOpen = "too many open tabs";
		const runChild = vi.fn(async () => ({ text: "x" }));
		const store = ledgerStore(threeItems());
		const { ctx } = makeCtx({ browser: tabs.browser, runChild, ledgerStore: store });
		await expect(executeDelegateTask(args(browserTask("e1")), ctx)).rejects.toThrow(/Could not open a browser tab for this item: too many open tabs/);
		expect(runChild).not.toHaveBeenCalled();
		expect(store.current()?.items.find((i) => i.id === "e1")).toMatchObject({ status: "failed", reason: "subagent" });
	});
});

describe("delegate_task browser_item: ledger e custo", () => {
	it("itens passam a in_progress, depois done com evidência ou failed com motivo e causa", async () => {
		const tabs = fakeTabs();
		const store = ledgerStore(threeItems());
		let midRun: string[] = [];
		const { ctx } = makeCtx({
			browser: tabs.browser,
			ledgerStore: store,
			runChild: async (input) => {
				midRun = store.current()!.items.map((item) => item.status);
				if (input.objective.includes("e2")) throw new Error("page crashed");
				return { text: `${input.objective} summary` };
			},
		});
		const { summary } = await executeDelegateTask(args(browserTask("e1"), browserTask("e2")), ctx);
		expect(midRun).toEqual(["in_progress", "in_progress", "pending"]);
		const items = Object.fromEntries(store.current()!.items.map((item) => [item.id, item]));
		expect(items.e1).toMatchObject({ status: "done", evidence: "Read e1 summary" });
		expect(items.e2).toMatchObject({ status: "failed", reason: "subagent" });
		expect(items.e2?.detail).toContain("page crashed");
		expect(items.e3?.status).toBe("pending");
		expect(summary).toContain("Item e1: done.");
		expect(summary).toContain("Item e2: failed");
		expect(summary).toContain("Read every failed item yourself");
	});

	it("filho em que todas as tools falharam é failed, não conteúdo (guarda 2 da V2)", async () => {
		const tabs = fakeTabs();
		const store = ledgerStore(threeItems());
		const { ctx } = makeCtx({
			browser: tabs.browser,
			ledgerStore: store,
			blindState: { failed: false },
			parentBrowserActive: () => true,
			runChild: async (input) => {
				await input.onEvent({ type: "tool_result", id: "1", name: "browser_text", ok: false, summary: "boom" });
				return { text: "I could not open the page." };
			},
		});
		await expect(executeDelegateTask(args(browserTask("e1")), ctx)).rejects.toThrow(/All sub-agents failed/);
		expect(store.current()?.items[0]).toMatchObject({ status: "failed", reason: "subagent" });
		// Em modo navegador a falha não ativa a trava de "filho cego" da V2.
		expect(ctx.blindState?.failed).toBe(false);
	});

	it("relatório do filho é cortado em 2 KB e as notas dele sobem para o pai", async () => {
		const tabs = fakeTabs();
		const notes = createResearchNotes();
		const { ctx } = makeCtx({
			browser: tabs.browser,
			researchNotes: notes,
			runChild: async (input) => {
				input.researchNotes.add({ sourceRef: "https://lms.test/e1", findings: "Week 1 covers limits", keyFacts: [], links: [], confidence: "medium" });
				return { text: "x".repeat(10_000) };
			},
		});
		const { summary } = await executeDelegateTask(args(browserTask("e1")), ctx);
		expect(summary).not.toContain("x".repeat(2_100));
		expect(summary).toContain("x".repeat(2_000));
		expect(notes.count()).toBe(1);
	});

	it("tokens e custo de todos os filhos somam no uso do pai", async () => {
		const tabs = fakeTabs();
		const { ctx, usage } = makeCtx({
			browser: tabs.browser,
			runChild: async (input) => {
				input.onUsage({ promptTokens: 80, completionTokens: 20, totalTokens: 100, costUsd: 0.01 });
				input.onUsage({ promptTokens: 80, completionTokens: 20, totalTokens: 100, costUsd: 0.01 });
				return { text: "ok" };
			},
		});
		await executeDelegateTask(args(browserTask("e1"), browserTask("e2"), browserTask("e3")), ctx);
		expect(usage.tokens).toBe(600);
		expect(usage.cost).toBeCloseTo(0.06, 5);
	});
});

describe("delegate_task browser_item: guardas", () => {
	it("sem o modo disponível (flag off) a chamada é recusada e nada abre", async () => {
		const { ctx } = makeCtx();
		await expect(executeDelegateTask(args(browserTask("e1")), ctx)).rejects.toThrow(/not available/);
	});

	it("pai no navegador + URL: sem o modo vale o bloqueio da V2 (dica aponta o modo se ele existir); com o modo, passa", async () => {
		const plain = { tasks: [{ goal: "Read https://lms.test/c/1" }] };
		const off = makeCtx({ parentBrowserActive: () => true });
		await expect(executeDelegateTask(plain, off.ctx)).rejects.toThrow(BLIND_DELEGATION_HINT);
		const tabs = fakeTabs();
		const on = makeCtx({ parentBrowserActive: () => true, browser: tabs.browser });
		await expect(executeDelegateTask(plain, on.ctx)).rejects.toThrow(BLIND_DELEGATION_HINT_BROWSER);
		await expect(executeDelegateTask(args(browserTask("e1")), on.ctx)).resolves.toMatchObject({ summary: expect.stringContaining("[ok]") });
	});

	it("a tool só anuncia o modo na variante com a flag; a flag nasce desligada", () => {
		const schema = (tool: typeof DELEGATE_TASK_TOOL) => JSON.stringify(tool.function.parameters);
		expect(schema(DELEGATE_TASK_TOOL)).not.toContain("browser_item");
		expect(schema(DELEGATE_TASK_BROWSER_TOOL)).toContain("browser_item");
		expect(DELEGATE_TASK_TOOL.function.description).toContain("Sub-agents cannot use the browser");
		expect(browserSubagentsEnabled({})).toBe(false);
		expect(browserSubagentsEnabled({ ATLAS_BROWSER_SUBAGENTS: "on" })).toBe(true);
	});
});
