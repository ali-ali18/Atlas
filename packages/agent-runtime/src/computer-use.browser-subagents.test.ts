import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { createSubagentRun } from "@workspace/db";
import { runComputerUse } from "./computer-use.js";
import { AgentRunCancelledError } from "./errors.js";

/**
 * V8 — delegate_task mode "browser_item": cada filho numa aba própria da sessão do pai,
 * resultado no ledger de itens do pai. LLM e sandbox mockados, sem banco nem rede.
 */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		createSubagentRun: vi.fn(),
		finishSubagentRun: vi.fn(async () => true),
		failOrphanSubagentRuns: vi.fn(async () => 0),
		appendAgentStep: vi.fn(async () => undefined),
	};
});

type Ev = Record<string, unknown> & { type: string };

function toolCalls(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: calls.map((call) => ({
				id: call.id,
				type: "function" as const,
				function: { name: call.name, arguments: JSON.stringify(call.args) },
			})),
		},
	};
}

const say = (content: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number }): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: { role: "assistant", content },
	usage,
});

const isChild = (params: CompleteChatWithToolsParams) => {
	const first = params.messages[0];
	return typeof first?.content === "string" && first.content.includes("focused sub-agent");
};
const childText = (params: CompleteChatWithToolsParams) => {
	const user = params.messages.find((m) => m.role === "user");
	return typeof user?.content === "string" ? user.content : "";
};
const hasToolResult = (params: CompleteChatWithToolsParams) => params.messages.some((m) => m.role === "tool");

/** Sandbox falso: registra abas abertas/fechadas e em qual aba cada leitura aconteceu. */
function fakeSandbox(opts: { failTabs?: (tabId: string | undefined) => boolean; openFails?: boolean } = {}) {
	const log = {
		opened: [] as Array<{ tabId: string; url?: string }>,
		closed: [] as string[],
		reads: [] as Array<{ tabId?: string }>,
		peakOpen: 0,
	};
	const open = new Set<string>();
	let seq = 0;
	const make = (context: { tabId?: string }): SandboxManager =>
		({
			withExecutionContext: (next: { tabId?: string }) => make(next),
			execTabOpen: async (_sessionId: string, url?: string) => {
				if (opts.openFails) throw new Error("too many open tabs");
				const tabId = `t${++seq}`;
				log.opened.push({ tabId, url });
				open.add(tabId);
				log.peakOpen = Math.max(log.peakOpen, open.size);
				return { tabId };
			},
			execTabClose: async (_sessionId: string, tabId: string) => {
				log.closed.push(tabId);
				open.delete(tabId);
				return { closed: true };
			},
			execBrowserText: async () => {
				log.reads.push({ tabId: context.tabId });
				await new Promise((resolve) => setTimeout(resolve, 20));
				if (opts.failTabs?.(context.tabId)) throw new Error("page crashed");
				return { url: "https://lms.test/c", title: "Course", text: `content read in tab ${context.tabId}` };
			},
		}) as unknown as SandboxManager;
	return { manager: make({}), log, openCount: () => open.size };
}

let childCounter = 0;

async function runParent(input: {
	sandbox: ReturnType<typeof fakeSandbox>;
	llm: (params: CompleteChatWithToolsParams, ctx: { parentCalls: number }) => Promise<CompleteChatWithToolsResult>;
	browserSubagents?: boolean;
	abortSignal?: AbortSignal;
}) {
	const events: Ev[] = [];
	const seen: Array<{ child: boolean; tools: string[]; system: string; text: string }> = [];
	const ctx = { parentCalls: 0 };
	const result = await runComputerUse({
		manager: input.sandbox.manager,
		getSessionId: async () => "sess-1",
		sandboxEnabled: true,
		browserSubagents: input.browserSubagents ?? true,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "read all weeks of my 3 courses" }],
		botId: "bot-1",
		userId: "user-1",
		runId: "run-parent",
		origin: "chat",
		maxSteps: 10,
		mcp: null,
		abortSignal: input.abortSignal,
		onEvent: (event) => {
			events.push(event as unknown as Ev);
		},
		streamChat: async (params, handlers) => {
			const child = isChild(params);
			const system = params.messages[0]?.content;
			seen.push({ child, tools: params.tools.map((t) => t.function.name), system: typeof system === "string" ? system : "", text: childText(params) });
			if (!child) ctx.parentCalls += 1;
			const reply = await input.llm(params, ctx);
			if (reply.message.content) handlers?.onDelta?.(reply.message.content);
			return reply;
		},
	});
	return { result, events, seen };
}

const declare = toolCalls([
	{
		id: "ti1",
		name: "track_items",
		args: { action: "set", items: [{ id: "e1", label: "Course A" }, { id: "e2", label: "Course B" }, { id: "e3", label: "Course C" }] },
	},
]);

const delegateThree = toolCalls([
	{
		id: "d1",
		name: "delegate_task",
		args: {
			mode: "browser_item",
			tasks: [
				{ item: "e1", url: "https://lms.test/a", goal: "Read weeks 1-2 of Course A" },
				{ item: "e2", url: "https://lms.test/b", goal: "Read weeks 1-2 of Course B" },
				{ item: "e3", url: "https://lms.test/c", goal: "Read weeks 1-2 of Course C" },
			],
		},
	},
]);

const getItems = toolCalls([{ id: "ti2", name: "track_items", args: { action: "get" } }]);

describe("delegate_task mode browser_item (V8)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		childCounter = 0;
		vi.mocked(createSubagentRun).mockImplementation(async () => ({ id: `child-${++childCounter}` }));
	});

	// Cada filho: lê a página (browser_text, alias de browser_read) e responde.
	const childLlm = (params: CompleteChatWithToolsParams) => {
		const course = /Course ([ABC])/.exec(childText(params))?.[1] ?? "?";
		if (!hasToolResult(params)) return toolCalls([{ id: `r-${course}`, name: "browser_text", args: {} }]);
		return say(`Course ${course}: weeks 1-2 read.`, { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.01 });
	};

	it("replay: 3 itens, 3 filhos em abas próprias; um falha e o item vira failed com motivo; abas fechadas", async () => {
		// A leitura da aba do curso C quebra: é a 3a aba aberta (t3).
		const sandbox = fakeSandbox({ failTabs: (tabId) => tabId === "t3" });
		let ledgerText = "";
		const { result, events, seen } = await runParent({
			sandbox,
			llm: async (params, ctx) => {
				if (isChild(params)) return childLlm(params);
				if (ctx.parentCalls === 1) return declare;
				if (ctx.parentCalls === 2) return delegateThree;
				if (ctx.parentCalls === 3) return getItems;
				return say("Done.", { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.002 });
			},
		});

		// Cada filho abriu a SUA aba na url do item e leu nela; o pai nunca leu (nenhuma leitura sem aba).
		expect(sandbox.log.opened.map((tab) => tab.url).sort()).toEqual(["https://lms.test/a", "https://lms.test/b", "https://lms.test/c"]);
		expect(sandbox.log.reads).toHaveLength(3);
		expect(sandbox.log.reads.every((read) => read.tabId !== undefined)).toBe(true);
		expect(new Set(sandbox.log.reads.map((read) => read.tabId)).size).toBe(3);
		// Todas as abas fechadas ao fim (sucesso e falha).
		expect(sandbox.log.closed.sort()).toEqual(sandbox.log.opened.map((tab) => tab.tabId).sort());
		expect(sandbox.openCount()).toBe(0);

		// Ferramentas do filho: DOM sim; tela da VM e delegação não. Prompt do filho tem a seção de navegador.
		const childCall = seen.find((s) => s.child)!;
		expect(childCall.tools).toEqual(expect.arrayContaining(["navigate", "browser_read", "browser_find", "browser_act", "browser_snapshot", "browser_wait", "research_note"]));
		// V6: nomes antigos não são oferecidos (só executam como alias, como o browser_text desta réplica).
		for (const legacy of ["browser_text", "browser_links", "browser_click", "browser_type"]) expect(childCall.tools).not.toContain(legacy);
		for (const banned of ["screenshot", "click", "type", "key", "scroll", "delegate_task", "track_items", "create_file"]) {
			expect(childCall.tools).not.toContain(banned);
		}
		expect(childCall.system).toContain("## Browser");
		expect(childCall.text).toContain("Your tab is already open on: https://lms.test/");

		// Ledger do pai: A e B done com evidência; C failed com motivo (aba quebrou) e a ordem para reler.
		const get = events.find((e) => e.type === "tool_result" && e.name === "track_items" && e.id === "ti2");
		ledgerText = String(get?.summary ?? "");
		expect(ledgerText).toContain("Items: 2/3 done, 1 failed");
		const delegateResult = events.find((e) => e.type === "tool_result" && e.name === "delegate_task");
		expect(delegateResult).toMatchObject({ ok: true });
		const summary = String(delegateResult?.summary);
		expect(summary).toContain("Item e1: done.");
		expect(summary).toContain("Item e3: failed");
		expect(summary).toContain("Read every failed item yourself");
		expect(summary).toContain("### Task 3 (item e3) [failed]");

		// Custo e tokens dos filhos entram no uso do pai: 3 x 150 + 15 e 3 x 0.01 + 0.002.
		expect(result.usage.totalTokens).toBe(3 * 150 + 15);
		expect(result.usage.costUsd).toBeCloseTo(0.032, 5);
	});

	it("sem a flag o modo não existe: a tool nem anuncia mode e a chamada é recusada com a dica da V2", async () => {
		const sandbox = fakeSandbox();
		const { events, seen } = await runParent({
			sandbox,
			browserSubagents: false,
			llm: async (params, ctx) => {
				if (isChild(params)) return childLlm(params);
				if (ctx.parentCalls === 1) return declare;
				if (ctx.parentCalls === 2) return delegateThree;
				return say("Done.");
			},
		});
		const parentTools = seen.find((s) => !s.child)!.tools;
		expect(parentTools).toContain("delegate_task");
		expect(sandbox.log.opened).toHaveLength(0);
		const failed = events.find((e) => e.type === "tool_result" && e.name === "delegate_task");
		expect(failed).toMatchObject({ ok: false });
		expect(String(failed?.summary)).toContain("not available");
	});

	it("não abre mais abas do que o teto: 5 tarefas em duas chamadas paralelas, no máximo 3 abertas", async () => {
		const sandbox = fakeSandbox();
		const call = (id: string, items: string[]) =>
			({ id, name: "delegate_task", args: { mode: "browser_item", tasks: items.map((item) => ({ item, url: `https://lms.test/${item}`, goal: `Read Course ${item === "e1" ? "A" : item === "e2" ? "B" : "C"} weeks` })) } });
		await runParent({
			sandbox,
			llm: async (params, ctx) => {
				if (isChild(params)) return childLlm(params);
				if (ctx.parentCalls === 1) return declare;
				if (ctx.parentCalls === 2) return toolCalls([call("d1", ["e1", "e2", "e3"]), call("d2", ["e1", "e2"])]);
				return say("Done.");
			},
		});
		expect(sandbox.log.opened).toHaveLength(5);
		expect(sandbox.log.peakOpen).toBeLessThanOrEqual(3);
		expect(sandbox.log.closed).toHaveLength(5);
	});

	it("cancelar o pai fecha as abas dos filhos", async () => {
		const sandbox = fakeSandbox();
		const abort = new AbortController();
		const run = runParent({
			sandbox,
			abortSignal: abort.signal,
			llm: async (params, ctx) => {
				if (isChild(params)) {
					if (!hasToolResult(params)) {
						// Cancela com os filhos no meio da leitura.
						setTimeout(() => abort.abort(new AgentRunCancelledError()), 5);
					}
					return childLlm(params);
				}
				if (ctx.parentCalls === 1) return declare;
				if (ctx.parentCalls === 2) return delegateThree;
				return say("Done.");
			},
		});
		await run.catch(() => undefined);
		expect(sandbox.log.opened.length).toBeGreaterThan(0);
		// O fechamento não depende do sinal cancelado (pode terminar logo depois do pai).
		await vi.waitFor(() => expect(sandbox.openCount()).toBe(0));
		expect(sandbox.log.closed.sort()).toEqual(sandbox.log.opened.map((tab) => tab.tabId).sort());
		expect(sandbox.openCount()).toBe(0);
	});

	it("aba que não abre: o item vira failed com o motivo real e nenhum filho roda", async () => {
		const sandbox = fakeSandbox({ openFails: true });
		const { events, seen } = await runParent({
			sandbox,
			llm: async (params, ctx) => {
				if (isChild(params)) return childLlm(params);
				if (ctx.parentCalls === 1) return declare;
				if (ctx.parentCalls === 2) return delegateThree;
				if (ctx.parentCalls === 3) return getItems;
				return say("Done.");
			},
		});
		expect(seen.some((s) => s.child)).toBe(false);
		const delegateResult = events.find((e) => e.type === "tool_result" && e.name === "delegate_task");
		// Todos falharam: o pai recebe erro (honesto), com o motivo.
		expect(delegateResult).toMatchObject({ ok: false });
		expect(String(delegateResult?.summary)).toContain("Could not open a browser tab");
		const get = events.find((e) => e.type === "tool_result" && e.name === "track_items" && e.id === "ti2");
		expect(String(get?.summary)).toContain("0/3 done, 3 failed");
	});
});
