import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { assembleMemoryContext } from "@workspace/db";
import { runComputerUse } from "./computer-use.js";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";

/**
 * F2 — prompt em tiers. Simula o cache do provider (reaproveita o MAIOR PREFIXO
 * do request anterior) e mede a razão cache/prompt de uma run longa, com as
 * notas de pesquisa (F3) ligadas e desligadas. LLM mockado, sem rede.
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

const toolset = buildMcpToolset(
	[
		{
			id: "c1",
			slug: "data",
			name: "Data",
			disabledTools: [],
			tools: [{ name: "fetch_page", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
		},
	],
	{},
);

type Message = CompleteChatWithToolsParams["messages"][number];
type Sent = { messages: Message[]; tools: string };

const serialize = (sent: Sent) => [sent.tools, ...sent.messages.map((m) => JSON.stringify(m))];

/** Caracteres do maior prefixo em comum (por mensagem; na primeira divergente, por caractere). */
function commonPrefixChars(a: string[], b: string[]): number {
	let chars = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
		if (a[i] === b[i]) {
			chars += a[i]!.length;
			continue;
		}
		const x = a[i]!;
		const y = b[i]!;
		let k = 0;
		while (k < Math.min(x.length, y.length) && x[k] === y[k]) k += 1;
		return chars + k;
	}
	return chars;
}

/** Razão cache/prompt das requests 2..n: cada uma reaproveita o prefixo da anterior. */
function simulatedCacheRatio(requests: Sent[]): number {
	let cached = 0;
	let total = 0;
	for (let i = 1; i < requests.length; i += 1) {
		const now = serialize(requests[i]!);
		cached += commonPrefixChars(serialize(requests[i - 1]!), now);
		total += now.reduce((sum, part) => sum + part.length, 0);
	}
	return total === 0 ? 0 : cached / total;
}

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001 };

async function run(input: { messages: Message[]; notes: boolean; decisions: number }) {
	const sent: Sent[] = [];
	let pages = 0;
	const mcp: McpRuntime = {
		toolset,
		call: vi.fn(async () => ({
			ok: true,
			text: `conteúdo da fonte ${pages++} sobre o assunto. ${"detalhe relevante da página. ".repeat(40)}`,
			truncated: false,
		})) as unknown as McpRuntime["call"],
	};
	let decision = 0;
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-cache",
		userId: "user-a",
		botId: "bot-a",
		conversationId: "conv-cache",
		origin: "chat",
		contextEconomy: true,
		messages: input.messages as never,
		maxSteps: 60,
		budget: { maxCostUsd: 100 },
		mcp,
		onEvent: () => undefined,
		streamChat: async (params) => {
			sent.push({ messages: JSON.parse(JSON.stringify(params.messages)) as Message[], tools: JSON.stringify(params.tools) });
			const index = decision++;
			if (index >= input.decisions) return { ...say("Pronto."), usage: USAGE };
			const next = input.notes && index % 2 === 1
				? turn(call(`n${index}`, "research_note", { sourceRef: `https://example.test/fonte-${index}`, findings: `Ponto ${index} da fonte.`, keyFacts: [`fato-${index}`], confidence: "high" }))
				: turn(call(`r${index}`, "mcp__data__fetch_page", { page: index }));
			return { ...next, usage: USAGE };
		},
	} as never);
	return sent;
}

const base: Message[] = [{ role: "user", content: "pesquisa o assunto a fundo" }];
const LAYER_HEAD = "Research notes so far";
const isLayer = (m: Message) => m.role === "system" && typeof m.content === "string" && m.content.startsWith(LAYER_HEAD);

describe("F2: cache hit ratio em run longa", () => {
	it("com research_note ligado, a razão cache/prompt fica >= 80% e a camada efêmera só ao fim", async () => {
		const sent = await run({ messages: base, notes: true, decisions: 20 });
		expect(sent.length).toBeGreaterThan(18);
		const withLayer = sent.filter((s) => s.messages.some(isLayer));
		expect(withLayer.length).toBeGreaterThan(5);
		for (const s of withLayer) expect(s.messages.findIndex(isLayer)).toBe(s.messages.length - 1);
		expect(simulatedCacheRatio(sent)).toBeGreaterThanOrEqual(0.8);
	});

	it("sem notas a razão também fica >= 80% e F3 ligado não degrada além de 5 pontos", async () => {
		const off = simulatedCacheRatio(await run({ messages: base, notes: false, decisions: 20 }));
		const on = simulatedCacheRatio(await run({ messages: base, notes: true, decisions: 20 }));
		expect(off).toBeGreaterThanOrEqual(0.8);
		expect(on).toBeGreaterThanOrEqual(off - 0.05);
	});

	it("o prompt do sistema não muda entre passos", async () => {
		const sent = await run({ messages: base, notes: true, decisions: 8 });
		const first = JSON.stringify(sent[0]!.messages[0]);
		expect(sent.every((s) => JSON.stringify(s.messages[0]) === first)).toBe(true);
	});
});

describe("F2: pedidos seguidos na mesma conversa", () => {
	const session = [
		{ role: "user" as const, content: "pergunta antiga" },
		{ role: "assistant" as const, content: "resposta antiga" },
	];
	const build = (relevantMemory: string, turnText: string): Message[] =>
		assembleMemoryContext({
			identity: "Bot identity block",
			profile: "USER profile block",
			summary: "Summary block",
			relevantMemory,
			sessionMessages: session,
			incoming: [{ role: "user", content: turnText }],
		}) as Message[];

	it("a memória por relevância muda e o prefixo (tools, sistema, contexto, histórico) continua idêntico", async () => {
		const a = await run({ messages: build("MEMORY: nota sobre prazos", "primeiro pedido"), notes: false, decisions: 2 });
		const b = await run({ messages: build("MEMORY: outra nota, bem diferente, sobre custos", "segundo pedido"), notes: false, decisions: 2 });
		// tools + sistema do runtime + 3 de contexto + 2 de histórico
		const prefixOf = (s: Sent) => serialize(s).slice(0, 1 + 1 + 3 + 2);
		expect(prefixOf(a[0]!)).toEqual(prefixOf(b[0]!));
		const memoryAt = a[0]!.messages.findIndex((m) => typeof m.content === "string" && m.content.startsWith("MEMORY:"));
		expect(memoryAt).toBe(a[0]!.messages.findIndex((m) => m.content === "primeiro pedido") - 1);
	});
});
