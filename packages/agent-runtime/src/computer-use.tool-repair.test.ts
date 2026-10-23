import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import { runComputerUse } from "./computer-use.js";
import { buildMcpToolset, type McpToolsetConnection } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

/**
 * Replay com o LLM mockado chamando nomes tortos (`Navigate`, `browser-snapshot`, `mcp_bling_listProducts`) e
 * JSON malformado: o runtime corrige quando há UM alvo seguro, roda a tool e diz no resultado como chamou.
 * Escrita nunca é alcançada por aproximação, e nome desconhecido volta com os mais próximos.
 */
const ERP: McpToolsetConnection = {
	id: "conn-bling",
	slug: "bling",
	name: "Bling",
	disabledTools: [],
	tools: [
		{ name: "listProducts", description: "List products", inputSchema: { type: "object", properties: { limit: { type: "integer" } } }, annotations: { readOnlyHint: true } },
		{ name: "createProduct", description: "Create a product", inputSchema: { type: "object", properties: { name: { type: "string" } } }, annotations: { readOnlyHint: false } },
	],
};

const call = (id: string, name: string, args: string): LlmToolCall => ({ id, type: "function", function: { name, arguments: args } });
const step = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls } });
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Pronto." } };

async function replay(script: CompleteChatWithToolsResult[]) {
	const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const mcp: McpRuntime = {
		toolset: buildMcpToolset([ERP], { autonomy: { level: "autonomous", exceptions: [] } }),
		call: async (name, args) => {
			mcpCalls.push({ name, args });
			return { ok: true, text: JSON.stringify({ products: [{ id: 1, name: "Caneca" }] }), truncated: false };
		},
	};
	const manager = {
		execNavigate: vi.fn(async () => ({ url: "https://loja.exemplo.com.br", title: "Loja" })),
		execBrowserSnapshot: vi.fn(async () => ({ url: "https://loja.exemplo.com.br", title: "Loja", total: 1, offset: 0, limit: 50, nextOffset: null, lines: ['[e1] button "Entrar"'] })),
	} as unknown as SandboxManager;
	const results: Array<{ id: string; name: string; ok: boolean; summary: string }> = [];
	const requests: CompleteChatWithToolsParams[] = [];
	const queue = [...script];
	await runComputerUse({
		manager,
		getSessionId: async () => "session-1",
		apiKey: "test",
		model: "m",
		runId: "run-repair",
		userId: "user-a",
		botId: "bot-a",
		origin: "chat",
		contextEconomy: true,
		autonomy: { level: "autonomous", exceptions: [] },
		mcp,
		messages: [{ role: "user", content: "abra o site loja.exemplo.com.br e liste os produtos do Bling" }],
		maxSteps: 8,
		onEvent: (event) => {
			if (event.type === "tool_result") results.push({ id: event.id, name: event.name, ok: event.ok, summary: event.summary });
		},
		streamChat: async (params) => {
			requests.push(JSON.parse(JSON.stringify(params)) as CompleteChatWithToolsParams);
			return queue.shift() ?? done;
		},
	});
	const toolMessage = (id: string) => {
		const message = requests.at(-1)!.messages.find((item) => item.role === "tool" && (item.tool_call_id ?? "").endsWith(`_${id}`));
		return typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "");
	};
	const sentCall = (id: string) => requests.at(-1)!.messages.flatMap((item) => item.tool_calls ?? []).find((item) => item.id.endsWith(`_${id}`));
	return { results, manager, mcpCalls, toolMessage, sentCall };
}

beforeEach(() => vi.clearAllMocks());

describe("transporte tolerante: nome de tool e argumentos", () => {
	it("Navigate, browser-snapshot e mcp_bling_listProducts rodam como as tools certas, com nota no resultado", async () => {
		const run = await replay([
			step(call("c1", "Navigate", '{"url": "https://loja.exemplo.com.br",}'), call("c2", "browser-snapshot", "{}")),
			step(call("c3", "mcp_bling_listProducts", "{'limit': 5}")),
			done,
		]);
		expect(run.results.map((item) => [item.name, item.ok])).toEqual([
			["navigate", true],
			["browser_snapshot", true],
			["mcp__bling__listProducts", true],
		]);
		expect(run.manager.execNavigate).toHaveBeenCalledWith("session-1", "https://loja.exemplo.com.br");
		expect(run.mcpCalls).toEqual([{ name: "mcp__bling__listProducts", args: { limit: 5 } }]);
		// O modelo vê o nome exato no histórico e a nota no resultado da chamada.
		expect(run.sentCall("c1")?.function).toEqual({ name: "navigate", arguments: '{"url":"https://loja.exemplo.com.br"}' });
		expect(run.sentCall("c3")?.function.name).toBe("mcp__bling__listProducts");
		expect(run.toolMessage("c1")).toContain("Called `Navigate` as `navigate`");
		expect(run.toolMessage("c1")).toContain("were not valid JSON");
		expect(run.toolMessage("c2")).toContain("Called `browser-snapshot` as `browser_snapshot`");
		expect(run.toolMessage("c3")).toContain("Called `mcp_bling_listProducts` as `mcp__bling__listProducts`");
	});

	it("escrita sem o conector no nome não é corrigida: falha com os nomes mais próximos e não executa", async () => {
		const run = await replay([step(call("c1", "createProduct", '{"name": "Caneca"}')), done]);
		expect(run.mcpCalls).toEqual([]);
		expect(run.results[0]).toMatchObject({ name: "createProduct", ok: false });
		expect(run.results[0]!.summary).toContain("is not available");
		expect(run.results[0]!.summary).toContain("Closest tools:");
		expect(run.results[0]!.summary).toContain("mcp__bling__createProduct");
	});

	it("nome desconhecido devolve até 3 nomes próximos; JSON irreparável continua erro de argumento", async () => {
		const run = await replay([step(call("c1", "send_whatsapp", "{}"), call("c2", "navigate", '{"url": "https://loja')), done]);
		expect(run.results[0]).toMatchObject({ name: "send_whatsapp", ok: false });
		expect(run.results[0]!.summary).toMatch(/Closest tools: [^,]+, [^,]+, [^,.]+\./);
		expect(run.results[1]).toMatchObject({ name: "navigate", ok: false });
		expect(run.results[1]!.summary).toMatch(/JSON/);
		expect(run.manager.execNavigate).not.toHaveBeenCalled();
	});
});
