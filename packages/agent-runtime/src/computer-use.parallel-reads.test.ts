import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { searchMemoryEntries } from "@workspace/db";
import { runComputerUse } from "./computer-use.js";
import { parallelBuiltinReadKey } from "./read-execution.js";

/**
 * Leituras nativas do mesmo passo (busca na memória, web, histórico) rodam juntas, com o teto por
 * tool respeitado e os resultados na ordem em que o modelo pediu. LLM e db mockados.
 */

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "Bot configurado." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	searchMemoryEntries: vi.fn(async () => []),
}));

type Message = CompleteChatWithToolsParams["messages"][number];

const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const turn = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls } });
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });

let inFlight = 0;
let maxInFlight = 0;
const started: string[] = [];

beforeEach(() => {
	inFlight = 0;
	maxInFlight = 0;
	started.length = 0;
	// Latência inversa à ordem: a primeira busca termina por último.
	vi.mocked(searchMemoryEntries).mockImplementation((async (input: { query: string }) => {
		started.push(input.query);
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		const delay = 30 - started.length * 10;
		await new Promise((resolve) => setTimeout(resolve, Math.max(1, delay)));
		inFlight -= 1;
		return [{ entry: { id: `m-${input.query}`, content: `lembrança sobre ${input.query}`, category: null, target: "memory" }, score: 1 }];
	}) as never);
});

async function run(script: CompleteChatWithToolsResult[], budget?: Record<string, unknown>) {
	const requests: Message[][] = [];
	const events: Array<{ type: string; name?: string; id?: string }> = [];
	let index = 0;
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		contextEconomy: false,
		apiKey: "test",
		model: "m",
		runId: "run-par",
		userId: "user-a",
		botId: "bot-a",
		conversationId: "conv-par",
		origin: "chat",
		messages: [{ role: "user", content: "o que você lembra sobre baterias, solar e vento?" }],
		maxSteps: 10,
		...(budget ? { budget } : {}),
		onEvent: (event: { type: string }) => {
			events.push(event as never);
		},
		streamChat: async (params: CompleteChatWithToolsParams) => {
			requests.push(JSON.parse(JSON.stringify(params.messages)) as Message[]);
			return script[Math.min(index++, script.length - 1)]!;
		},
	} as never);
	return { requests, events };
}

const toolMessages = (messages: Message[]) => messages.filter((message) => message.role === "tool") as Array<{ tool_call_id: string; content: string }>;

describe("leituras nativas em paralelo", () => {
	it("três memory_search do mesmo passo rodam juntas e voltam na ordem pedida", async () => {
		const { requests } = await run([
			turn(call("a", "memory_search", { query: "baterias" }), call("b", "memory_search", { query: "solar" }), call("c", "memory_search", { query: "vento" })),
			say("Pronto."),
		]);
		expect(maxInFlight).toBe(3);
		const results = toolMessages(requests[1] ?? []);
		expect(results.map((message) => message.tool_call_id.split("_").pop())).toEqual(["a", "b", "c"]);
		expect(results[0]!.content).toContain("baterias");
		expect(results[2]!.content).toContain("vento");
	});

	it("perto do teto da tool, roda uma por vez e o teto continua exato", async () => {
		const { requests } = await run(
			[
				turn(call("a", "memory_search", { query: "baterias" }), call("b", "memory_search", { query: "solar" }), call("c", "memory_search", { query: "vento" })),
				say("Pronto."),
			],
			{ maxCallsPerTool: { memory_search: 2 } },
		);
		expect(maxInFlight).toBe(1);
		expect(started).toEqual(["baterias", "solar"]);
		const results = toolMessages(requests[1] ?? []);
		expect(results).toHaveLength(3);
		expect(results[2]!.content).toMatch(/Limite de 2 chamadas de memory_search/);
	});

	it("chamada repetida (mesmos args) espera a anterior", async () => {
		await run([
			turn(call("a", "memory_search", { query: "baterias" }), call("b", "memory_search", { query: "baterias" })),
			say("Pronto."),
		]);
		expect(maxInFlight).toBe(1);
	});
});

describe("parallelBuiltinReadKey", () => {
	it("só leituras nativas sem efeito ganham chave", () => {
		expect(parallelBuiltinReadKey("web_search", JSON.stringify({ query: "x" }))).not.toBeNull();
		expect(parallelBuiltinReadKey("web_extract", JSON.stringify({ urls: ["https://a.b"] }))).not.toBeNull();
		expect(parallelBuiltinReadKey("session_search", JSON.stringify({ query: "x" }))).not.toBeNull();
		expect(parallelBuiltinReadKey("memory_search", JSON.stringify({ query: "x" }))).not.toBeNull();
		expect(parallelBuiltinReadKey("memory", JSON.stringify({ action: "list" }))).not.toBeNull();
		// Escrita, card ou estado do run: barreira.
		expect(parallelBuiltinReadKey("memory", JSON.stringify({ action: "add", content: "x" }))).toBeNull();
		expect(parallelBuiltinReadKey("create_file", "{}")).toBeNull();
		expect(parallelBuiltinReadKey("checkpoint_read", "{}")).toBeNull();
		expect(parallelBuiltinReadKey("web_search", "{quebrado")).toBeNull();
	});

	it("a chave não depende da ordem dos argumentos", () => {
		expect(parallelBuiltinReadKey("web_search", '{"query":"x","num":3}')).toBe(parallelBuiltinReadKey("web_search", '{"num":3,"query":"x"}'));
	});
});
