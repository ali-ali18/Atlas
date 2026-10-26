import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { clearExtractCache, clearExtractRateLimits, clearExtractRobotsCache } from "@workspace/search";
import { runComputerUse } from "./computer-use.js";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { ARGUMENT_ERROR_HINT } from "./tool-failure.js";

/**
 * Bloqueio de tool por falhas seguidas: só falha `other` conta, o bloqueio expira depois de 3
 * passos sem chamar a tool, e o resultado sintético ("tool bloqueada") não derruba o run.
 * LLM, fetch e conector mockados; URLs por IP literal (sem DNS).
 */

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

type Message = CompleteChatWithToolsParams["messages"][number];
type Ev = Record<string, unknown> & { type: string };

const call = (id: string, name: string, args: Record<string, unknown> = {}): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const turn = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: calls },
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });

const LONG = "Texto do artigo com conteúdo suficiente para passar do mínimo de caracteres da extração. ".repeat(8);
const page = (title: string, body: string) => `<html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;

const urls = [1, 2, 3, 4, 5].map((n) => `https://93.184.216.34/p${n}`);
const deadUrls = new Set(urls.slice(0, 3));
let pageCalls: string[] = [];

beforeEach(() => {
	clearExtractCache();
	clearExtractRateLimits();
	clearExtractRobotsCache();
	pageCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
			pageCalls.push(url);
			if (deadUrls.has(url)) return new Response("not found", { status: 404 });
			return new Response(page(url.split("/").pop() ?? "p", LONG), { status: 200, headers: { "content-type": "text/html" } });
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const connector = {
	id: "conn-erp",
	slug: "erp",
	name: "ERP",
	disabledTools: [],
	tools: ["read_a", "read_b", "read_c"].map((name) => ({
		name,
		description: "Lê",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	})),
};

async function run(input: {
	script: (ctx: { index: number; messages: Message[] }) => CompleteChatWithToolsResult;
	mcpCall?: ReturnType<typeof vi.fn>;
	extra?: Record<string, unknown>;
}) {
	const events: Ev[] = [];
	const requests: Message[][] = [];
	let index = 0;
	const mcp: McpRuntime | null = input.mcpCall
		? {
				toolset: buildMcpToolset([connector], { autonomy: { level: "autonomous", exceptions: [] }, maxTools: 40 }),
				call: input.mcpCall as never,
			}
		: null;
	let error: unknown;
	let result: Awaited<ReturnType<typeof runComputerUse>> | undefined;
	try {
		result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "unused",
			sandboxEnabled: false,
			apiKey: "test",
			model: "m",
			runId: "run-block",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-block",
			origin: "chat",
			messages: [{ role: "user", content: "leia os links" }],
			maxSteps: 30,
			mcp,
			onEvent: (event) => {
				events.push(event as never);
			},
			streamChat: async (params: CompleteChatWithToolsParams) => {
				if (params.maxOutputTokens === 60) return { model: "cheap", message: { role: "assistant", content: '{"fixFile": false}' } };
				const messages = JSON.parse(JSON.stringify(params.messages)) as Message[];
				requests.push(messages);
				return input.script({ index: index++, messages });
			},
			...input.extra,
		} as never);
	} catch (caught) {
		error = caught;
	}
	const results = events.filter((e) => e.type === "tool_result") as Array<Ev & { id: string; name: string; ok: boolean; summary: string }>;
	return { result, error, events, results, requests };
}

describe("link morto não bloqueia a tool de leitura", () => {
	it("lote de 5 URLs com as 3 primeiras mortas (404): as 2 últimas ainda são lidas e a dica de argumento não aparece", async () => {
		const { result, error, results } = await run({
			script: ({ index }) => (index < 5 ? turn(call(`u${index}`, "web_extract", { urls: [urls[index]!] })) : say("Li os dois links que abriram.")),
		});
		expect(error).toBeUndefined();
		expect(result?.text).toBe("Li os dois links que abriram.");
		const extracts = results.filter((r) => r.name === "web_extract");
		expect(extracts).toHaveLength(5);
		// As 4ª e 5ª URLs foram de fato buscadas e voltaram com conteúdo.
		expect(pageCalls).toEqual(expect.arrayContaining([urls[3]!, urls[4]!]));
		expect(extracts[3]!.ok).toBe(true);
		expect(extracts[4]!.ok).toBe(true);
		expect(extracts[3]!.summary).toContain("Texto do artigo");
		for (const item of results) {
			expect(item.summary).not.toContain("indisponível neste run");
			expect(item.summary).not.toContain(ARGUMENT_ERROR_HINT);
		}
	});

	it("as mesmas 3 URLs mortas em sequência também não bloqueiam (sem dica de 'não chute')", async () => {
		const { results } = await run({
			script: ({ index }) => (index < 3 ? turn(call(`d${index}`, "web_extract", { urls: [urls[index]!] })) : index === 3 ? turn(call("late", "web_extract", { urls: [urls[3]!] })) : say("fim")),
		});
		const extracts = results.filter((r) => r.name === "web_extract");
		expect(extracts).toHaveLength(4);
		expect(extracts[3]!.summary).toContain("Texto do artigo");
		expect(extracts.every((r) => !r.summary.includes(ARGUMENT_ERROR_HINT))).toBe(true);
	});
});

describe("bloqueio de tool expira", () => {
	it("3 falhas bloqueiam; depois de 3 passos sem chamar a tool ela volta a rodar", async () => {
		const mcpCall = vi.fn(async (name: string) => (name.endsWith("read_a") ? { ok: false, text: "upstream exploded", truncated: false } : { ok: true, text: "dados", truncated: false }));
		// passos 0-2: read_a falha (3ª bloqueia); 3: read_a bloqueada (sintético); 4-6: outra tool; 7-9: sem chamar a tool;
		// 10: read_a de novo, já fora do bloqueio.
		const { result, error, results } = await run({
			mcpCall,
			script: ({ index }) => {
				if (index < 3) return turn(call(`a${index}`, "mcp__erp__read_a", { n: index }));
				if (index === 3) return turn(call("blocked", "mcp__erp__read_a", { n: 3 }));
				if (index < 8) return turn(call(`b${index}`, "mcp__erp__read_b", { n: index }));
				if (index === 8) return turn(call("again", "mcp__erp__read_a", { n: 8 }));
				return say("fim");
			},
		});
		expect(error).toBeUndefined();
		expect(result?.text).toBe("fim");
		const byId = Object.fromEntries(results.map((r) => [r.id.split("_").pop(), r]));
		expect(byId.blocked!.ok).toBe(false);
		expect(byId.blocked!.summary).toContain("indisponível neste run");
		// A chamada sintética não chegou ao conector; a de depois da expiração chegou.
		const readA = mcpCall.mock.calls.filter(([name]) => String(name).endsWith("read_a"));
		expect(readA).toHaveLength(4);
		expect(byId.again!.summary).not.toContain("indisponível neste run");
	});

	it("insistir na tool bloqueada renova o bloqueio (não expira enquanto o modelo bate nela)", async () => {
		const mcpCall = vi.fn(async () => ({ ok: false, text: "upstream exploded", truncated: false }));
		const { results } = await run({
			mcpCall,
			script: ({ index }) => {
				if (index < 7) return turn(call(`a${index}`, "mcp__erp__read_a", { n: index }));
				return say("fim");
			},
		});
		// 3 reais e 4 sintéticos seguidos: nenhuma passou do bloqueio.
		expect(mcpCall).toHaveBeenCalledTimes(3);
		expect(results.filter((r) => r.summary.includes("indisponível neste run"))).toHaveLength(4);
	});
});

describe("resultado sintético não derruba o run", () => {
	it("tool bloqueada chamada de novo + falhas de outras tools não disparam a trava global", async () => {
		const mcpCall = vi.fn(async () => ({ ok: false, text: "upstream exploded", truncated: false }));
		// a, a, a (bloqueia) + 2 sintéticos + b + c: antes eram 7 passos falhando com 3 tools (abortava);
		// agora os sintéticos são neutros e só 5 passos contam.
		const { result, error } = await run({
			mcpCall,
			script: ({ index }) => {
				if (index < 3) return turn(call(`a${index}`, "mcp__erp__read_a", { n: index }));
				if (index < 5) return turn(call(`s${index}`, "mcp__erp__read_a", { n: index }));
				if (index === 5) return turn(call("b", "mcp__erp__read_b", { n: 5 }));
				if (index === 6) return turn(call("c", "mcp__erp__read_c", { n: 6 }));
				return say("Não consegui ler o ERP, segue o que tenho.");
			},
		});
		expect(error).toBeUndefined();
		expect(result?.text).toBe("Não consegui ler o ERP, segue o que tenho.");
	});
});
