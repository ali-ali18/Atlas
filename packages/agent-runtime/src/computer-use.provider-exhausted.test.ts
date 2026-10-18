import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { clearExtractCache, clearExtractRateLimits, clearExtractRobotsCache } from "@workspace/search";
import { runComputerUse } from "./computer-use.js";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { CONTINUE_AFTER_EXHAUSTION_NOTE, createProviderHealth } from "./tools/provider-health.js";
import { NO_BROWSER_EXTRACT_HINT } from "./web-extract.js";

/**
 * Pesquisa em que o provedor pago fica sem créditos no meio (caso real: Firecrawl 402).
 * O run não insiste no provedor, lê pelo leitor direto e não encerra oferecendo "retomar
 * depois". LLM e fetch mockados; URLs por IP literal (sem DNS).
 */

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	persistUserArtifact: vi.fn(async (input: { runId: string; kind: string; bytes: Uint8Array; mime: string; meta?: object }) => ({
		id: "art-1",
		kind: input.kind,
		meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength },
		runId: input.runId,
		conversationId: "conv-ex",
		createdAt: new Date(),
	})),
	nextFileVersion: vi.fn(async () => 1),
	countRunFileArtifacts: vi.fn(async () => 0),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

vi.mock("./files/pdf-chromium.js", () => ({
	printPdfWithChromium: vi.fn(async () => new TextEncoder().encode("%PDF-1.4 fake")),
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
const SPA = `<html><head><title>app</title></head><body><div id="root"></div></body></html>`;
const SEARCH_HTML = `<div class="result results_links web-result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2F93.184.216.34%2Fok1">Fonte 1</a></h2></div>`;

let apiCalls: string[] = [];
let pageCalls: string[] = [];

function stubNetwork() {
	apiCalls = [];
	pageCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url.startsWith("https://api.firecrawl.dev/")) {
				apiCalls.push(url);
				return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
			}
			if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
			if (url.includes("duckduckgo.com")) return new Response(SEARCH_HTML, { status: 200, headers: { "content-type": "text/html" } });
			pageCalls.push(url);
			const body = url.includes("/spa") ? SPA : page(url.split("/").pop() ?? "p", LONG);
			return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
		}),
	);
}

beforeEach(() => {
	clearExtractCache();
	clearExtractRateLimits();
	clearExtractRobotsCache();
	vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");
	stubNetwork();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function run(input: {
	message?: string;
	llm: (ctx: { index: number; messages: Message[] }) => CompleteChatWithToolsResult;
	mcp?: McpRuntime;
	providerHealth?: ReturnType<typeof createProviderHealth>;
}) {
	const requests: Message[][] = [];
	const events: Ev[] = [];
	let index = 0;
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-ex",
		userId: "user-a",
		botId: "bot-a",
		conversationId: "conv-ex",
		origin: "chat",
		messages: [{ role: "user", content: input.message ?? "pesquise e gere um PDF" }],
		maxSteps: 30,
		mcp: input.mcp,
		providerHealth: input.providerHealth,
		onEvent: (event) => {
			events.push(event as never);
		},
		streamChat: async (params) => {
			// Checagem barata de correção de arquivo (60 tokens): não é um passo do roteiro.
			if (params.maxOutputTokens === 60) return { model: "cheap", message: { role: "assistant", content: "{\"fixFile\": false}" } };
			const messages = JSON.parse(JSON.stringify(params.messages)) as Message[];
			requests.push(messages);
			return input.llm({ index: index++, messages });
		},
	} as never);
	return { result, requests, events };
}

const toolResults = (messages: Message[], id: string): string =>
	messages
		.filter((m) => m.role === "tool" && (m as { tool_call_id?: string }).tool_call_id === id)
		.map((m) => String(m.content))
		.join("\n");

describe("web_extract: Firecrawl sem créditos", () => {
	it("402 marca o provedor: o segundo lote não o chama e o leitor direto entrega as demais páginas", async () => {
		const { requests } = await run({
			llm: ({ index }) => {
				if (index === 0) return turn(call("e1", "web_extract", { urls: ["https://93.184.216.34/spa1", "https://93.184.216.34/ok1"] }));
				if (index === 1) return turn(call("e2", "web_extract", { urls: ["https://93.184.216.34/spa2", "https://93.184.216.34/ok2"] }));
				return say("Pronto.");
			},
		});
		const first = JSON.parse(toolResults(requests[1] ?? [], "e1"));
		const second = JSON.parse(toolResults(requests[2] ?? [], "e2"));
		// Fallback direto devolve conteúdo mesmo com o pago fora.
		expect(first.items[1].content).toContain("Texto do artigo");
		expect(second.items[1].content).toContain("Texto do artigo");
		// Uma chamada ao pago (a que falhou); o aviso vem uma vez só.
		expect(apiCalls).toHaveLength(1);
		expect(first.providerNote).toMatch(/out of credits or quota/);
		expect(second.providerNote).toBeUndefined();
		// Sem navegador no run, a dica não manda o modelo para uma tool que ele não tem.
		expect(first.items[0].error.escalateHint).toBe(NO_BROWSER_EXTRACT_HINT);
		expect(second.items[0].error.escalateHint).toBe(NO_BROWSER_EXTRACT_HINT);
	});

	it("SSRF: o leitor direto recusa loopback, metadata e redirect para rede interna", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = String(input);
				if (url.startsWith("https://api.firecrawl.dev/")) return new Response("{}", { status: 402 });
				if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
				if (url.includes("/redir")) return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
				pageCalls.push(url);
				return new Response(page("x", LONG), { status: 200, headers: { "content-type": "text/html" } });
			}),
		);
		const { requests } = await run({
			llm: ({ index }) =>
				index === 0
					? turn(call("s1", "web_extract", { urls: ["http://127.0.0.1:3001/v1/settings", "http://169.254.169.254/latest", "https://93.184.216.34/redir"] }))
					: say("Pronto."),
		});
		const out = JSON.parse(toolResults(requests[1] ?? [], "s1"));
		for (const item of out.items) expect(item.error?.code, item.url).toBe("blocked");
		// Nada interno foi buscado.
		expect(pageCalls.filter((url) => url.includes("127.0.0.1") || url.includes("169.254"))).toEqual([]);
	});
});

describe("web_search: API paga sem créditos", () => {
	it("402 uma vez; as buscas seguintes vão direto à nativa", async () => {
		const { requests } = await run({
			llm: ({ index }) => {
				if (index === 0) return turn(call("q1", "web_search", { query: "energia solar custo" }));
				if (index === 1) return turn(call("q2", "web_search", { query: "energia solar bancos" }));
				return say("Pronto.");
			},
		});
		expect(apiCalls).toHaveLength(1);
		expect(toolResults(requests[1] ?? [], "q1")).toContain("93.184.216.34/ok1");
		expect(toolResults(requests[2] ?? [], "q2")).toContain("93.184.216.34/ok1");
	});
});

describe("conector MCP sem créditos (Firecrawl 402)", () => {
	const toolset = buildMcpToolset(
		[
			{
				id: "conn-fc",
				slug: "firecrawl",
				name: "Firecrawl",
				catalogId: "firecrawl",
				disabledTools: [],
				tools: [
					{ name: "firecrawl_scrape", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
					{ name: "firecrawl_search", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
				],
			},
		],
		{ maxTools: 50 },
	);
	const mcpWith = (callFn: McpRuntime["call"]): McpRuntime => ({ toolset, call: callFn });
	const noCredits = () => ({ ok: false, text: "[Firecrawl] Request failed with status code 402", truncated: false });

	it("primeira falha traz um aviso com alternativas reais; as seguintes não chamam o conector", async () => {
		const callFn = vi.fn(async () => noCredits()) as unknown as McpRuntime["call"];
		const { requests } = await run({
			mcp: mcpWith(callFn),
			llm: ({ index }) => {
				if (index === 0) return turn(call("m1", "mcp__firecrawl__firecrawl_scrape", { url: "https://a.test/1" }));
				if (index === 1) return turn(call("m2", "mcp__firecrawl__firecrawl_scrape", { url: "https://a.test/2" }), call("m3", "mcp__firecrawl__firecrawl_search", { query: "x" }));
				return say("Pronto.");
			},
		});
		const first = toolResults(requests[1] ?? [], "m1");
		expect(first).toContain("out of credits or over its quota");
		expect(first).toContain("web_search, web_extract");
		expect(first).not.toContain("navigate");
		for (const id of ["m2", "m3"]) {
			const text = toolResults(requests[2] ?? [], id);
			expect(text).toContain("unavailable for the rest of this run");
		}
		expect(callFn).toHaveBeenCalledTimes(1);
	});

	it("o subagente herda o estado do pai: conector já esgotado nem é chamado", async () => {
		const health = createProviderHealth();
		health.markExhausted("conn-fc");
		const callFn = vi.fn(async () => noCredits()) as unknown as McpRuntime["call"];
		const { requests } = await run({
			mcp: mcpWith(callFn),
			providerHealth: health,
			llm: ({ index }) =>
				index === 0 ? turn(call("h1", "mcp__firecrawl__firecrawl_scrape", { url: "https://a.test/1" })) : say("Pronto."),
		});
		expect(toolResults(requests[1] ?? [], "h1")).toContain("unavailable for the rest of this run");
		expect(callFn).not.toHaveBeenCalled();
	});

	it("replay: créditos acabam, o modelo tenta encerrar oferecendo retomar; segue pelo leitor direto e entrega o arquivo", async () => {
		const callFn = vi.fn(async () => noCredits()) as unknown as McpRuntime["call"];
		const OFFER = "A pesquisa ficou parcial. Se quiser, eu retomo as páginas que faltaram.";
		const FINAL = "Pronto: o PDF completo está no chat.";
		const { result, requests, events } = await run({
			mcp: mcpWith(callFn),
			llm: ({ index }) => {
				switch (index) {
					case 0:
						return turn(call("r1", "mcp__firecrawl__firecrawl_scrape", { url: "https://93.184.216.34/ok1" }));
					case 1:
						return say(OFFER);
					case 2:
						return turn(call("r2", "web_extract", { urls: ["https://93.184.216.34/ok1", "https://93.184.216.34/ok2"] }));
					case 3:
						return turn(call("r3", "create_file", { filename: "pesquisa.pdf", content: "# Pesquisa\n\nDados lidos de duas fontes.\n" }));
					default:
						return say(FINAL);
				}
			},
		});
		// A oferta não encerrou o run: houve um aviso único e o trabalho seguiu.

		expect(result.text).toBe(FINAL);
		const notes = (requests[2] ?? []).filter((m) => m.role === "system" && m.content === CONTINUE_AFTER_EXHAUSTION_NOTE);
		expect(notes).toHaveLength(1);
		const extracted = JSON.parse(toolResults(requests[3] ?? [], "r2"));
		expect(extracted.items.map((item: { content?: string }) => item.content).every((c: string | undefined) => c?.includes("Texto do artigo"))).toBe(true);
		expect(events.filter((event) => event.type === "file")).toHaveLength(1);
		expect(callFn).toHaveBeenCalledTimes(1);
		// Recuperou pelo leitor direto: a resposta final não ganha nova cutucada (5 chamadas ao modelo).
		expect(requests).toHaveLength(5);
	});

	it("sem provedor esgotado a resposta final não recebe a cutucada", async () => {
		const okCall = vi.fn(async () => ({ ok: true, text: "conteúdo", truncated: false })) as unknown as McpRuntime["call"];
		const { result, requests } = await run({
			mcp: mcpWith(okCall),
			llm: ({ index }) =>
				index === 0 ? turn(call("n1", "mcp__firecrawl__firecrawl_scrape", { url: "https://a.test/1" })) : say("Resposta direta."),
		});
		expect(result.text).toBe("Resposta direta.");
		expect(requests.flat().some((m) => m.role === "system" && m.content === CONTINUE_AFTER_EXHAUSTION_NOTE)).toBe(false);
	});
});
