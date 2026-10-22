import { afterEach, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult, LlmMessage, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { runComputerUse } from "../computer-use.js";
import { MCP_RESULT_MAX_CHARS, capResultText } from "../mcp/call.js";
import { buildMcpToolset } from "../mcp/registry.js";
import { contentHash } from "./item-ids.js";
import { buildClipHint } from "./pagination.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

/**
 * Replay genérico (sem rede, LLM e conector simulados) do padrão observado em
 * runs reais: varreduras completas repetidas com texto livre diferente,
 * refinamentos sem paginar e descoberta de tool já carregada. Nada aqui é de
 * um conector real: `list_items`/`get_item` são tools fictícias.
 */
const autonomy = { level: "autonomous" as const, exceptions: [] };
const CATALOG = Array.from({ length: 900 }, (_, i) => ({
	id: i + 1,
	name: `Item ${i + 1}`,
	category: `group-${i % 7}`,
	price: 10 + (i % 90),
	description: `Synthetic catalog entry number ${i + 1} used only by the replay test, padded to a realistic row size.`,
}));
const connection = {
	id: "conn-shop",
	slug: "shop",
	name: "Shop",
	disabledTools: [],
	tools: [
		{
			name: "list_items",
			description: "List catalog items.",
			inputSchema: {
				type: "object",
				properties: {
					explanation: { type: "string", description: "Short explanation of why this call is made." },
					page: { type: "integer" },
					limit: { type: "integer" },
					name: { type: "string" },
				},
			},
			annotations: { readOnlyHint: true },
		},
		{
			name: "get_item",
			description: "Get one item.",
			inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			annotations: { readOnlyHint: true },
		},
	],
};
// maxTools: 1 deixa o conjunto deferred: o modelo precisa carregar a tool por busca.
const toolset = buildMcpToolset([connection], { autonomy, maxTools: 1 });
const LIST = "mcp__shop__list_items";

const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const reply = (calls: LlmToolCall[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: calls },
});
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Done." } };

/** Padrão do modelo A: varreduras repetidas, refinamentos sem paginar, busca redundante. */
const SCRIPT: LlmToolCall[][] = [
	[call("d0", "mcp_tool_search", { query: "list_items" })],
	[call("d1", LIST, { explanation: "scan the whole catalog", limit: 300 })],
	[call("d2", LIST, { explanation: "re-reading to make sure nothing is missing", limit: 300 })],
	[call("d3", "mcp_tool_search", { query: "list items matching a name" })],
	[call("d4", LIST, { explanation: "another look with a bigger limit", limit: 350 })],
	[call("d5", LIST, { explanation: "refining with an empty filter", limit: 300, name: "" })],
	[call("d6", LIST, { explanation: "one more verification", limit: 300, name: " " })],
	[call("d7", LIST, { explanation: "now the next page", limit: 300, page: 2 })],
];

function listItems(args: Record<string, unknown>): string {
	const limit = Math.min(300, Number(args.limit ?? 100));
	const page = Math.max(1, Number(args.page ?? 1));
	const name = String(args.name ?? "").trim().toLowerCase();
	const rows = CATALOG.filter((item) => item.name.toLowerCase().includes(name));
	return JSON.stringify({ total: rows.length, page, data: rows.slice((page - 1) * limit, page * limit) });
}

const messageChars = (message: LlmMessage): number =>
	(typeof message.content === "string" ? message.content.length : JSON.stringify(message.content ?? "").length) +
	(message.tool_calls ? JSON.stringify(message.tool_calls).length : 0);

async function replay(discipline: boolean) {
	const requests: LlmMessage[][] = [];
	const toolSummaries = new Map<string, string>();
	const connectorCalls: Array<Record<string, unknown>> = [];
	// O que o modelo viu de cada resultado na primeira vez que ele entrou no prompt.
	const firstSeen = new Map<string, string>();
	let checkpoint: AgentRunCheckpoint | undefined;
	let decision = 0;
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: discipline ? "run-on" : "run-off",
		userId: "user-a",
		origin: "chat",
		autonomy,
		executionDiscipline: discipline,
		maxSteps: 30,
		messages: [{ role: "user", content: "List all items whose name matches X and tell me how many there are." }],
		mcp: {
			toolset,
			call: async (name, args) => {
				connectorCalls.push(args);
				const schema = toolset.available.get(name)!.function.parameters;
				const text = name.endsWith("list_items") ? listItems(args) : "{}";
				// Mesmo caminho do conector real: corte com dica montada do schema (flag ligada).
				const capped = capResultText(
					text,
					MCP_RESULT_MAX_CHARS,
					discipline ? ({ shownItems }) => buildClipHint({ schema, args, shownItems, text }) : undefined,
				);
				return { ok: true, ...capped };
			},
		},
		onEvent: () => undefined,
		onStep: async (step) => {
			if (step.type === "tool_result") {
				toolSummaries.set(step.idempotencyKey, (step.outputJson as { summary: string }).summary);
			}
		},
		findCompletedTool: async (key) => {
			const summary = toolSummaries.get(key);
			return summary === undefined ? null : { ok: true, summary };
		},
		onCheckpoint: async (value) => {
			checkpoint = value;
		},
		streamChat: async (params) => {
			requests.push(JSON.parse(JSON.stringify(params.messages)) as LlmMessage[]);
			for (const message of params.messages) {
				if (message.role === "tool" && message.tool_call_id && typeof message.content === "string" && !firstSeen.has(message.tool_call_id.replace(/^r[0-9a-z]{6}_/, ""))) {
					firstSeen.set(message.tool_call_id.replace(/^r[0-9a-z]{6}_/, ""), message.content);
				}
			}
			const next = SCRIPT[decision++];
			return next ? reply(next) : done;
		},
	});

	const toolTexts = (request: LlmMessage[]) =>
		request.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : ""));
	const promptChars = requests.reduce((sum, request) => sum + request.reduce((s, m) => s + messageChars(m), 0), 0);
	const toolPayloadChars = requests.reduce(
		(sum, request) => sum + toolTexts(request).reduce((s, text) => s + text.length, 0),
		0,
	);
	// Custo efetivo de entrada com cache perfeito por prefixo: o que repete o
	// request anterior (em bytes, mensagem a mensagem) custa 10%.
	let effectiveInput = 0;
	let previous: string[] = [];
	for (const request of requests) {
		const serialized = request.map((m) => JSON.stringify(m));
		let shared = 0;
		let sharedChars = 0;
		while (shared < previous.length && shared < serialized.length && previous[shared] === serialized[shared]) {
			sharedChars += serialized[shared]!.length;
			shared += 1;
		}
		const total = serialized.reduce((s, m) => s + m.length, 0);
		effectiveInput += sharedChars * 0.1 + (total - sharedChars);
		previous = serialized;
	}
	const systemTexts = (request: LlmMessage[]) =>
		request.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : ""));
	return { requests, firstSeen, toolSummaries, connectorCalls, checkpoint, promptChars, toolPayloadChars, effectiveInput, toolTexts, systemTexts };
}

afterEach(() => vi.unstubAllEnvs());

it("replay: disciplina ligada corta payload e prompt, nomeia a paginação e dispara os avisos", { timeout: 20_000 }, async () => {
	const off = await replay(false);
	const on = await replay(true);

	// 1. Leituras repetidas viram cache hit (texto livre diferente) ou referência (conteúdo idêntico).
	expect(on.connectorCalls.filter((args) => args.explanation === "re-reading to make sure nothing is missing")).toHaveLength(0);
	expect(off.connectorCalls.filter((args) => args.explanation === "re-reading to make sure nothing is missing")).toHaveLength(1);
	expect(on.connectorCalls.length).toBeLessThan(off.connectorCalls.length);
	expect(on.firstSeen.get("d2")).toMatch(/^Already read this result/);
	expect(off.firstSeen.get("d2")).toContain('"total":900');
	for (const id of ["d4", "d5", "d6"]) {
		expect(on.firstSeen.get(id)).toMatch(
			/^Identical to the result of mcp__shop__list_items at step 2 \(result_ref: run-on:\d+:r[0-9a-z]{6}_d1:[\w]+\); reuse it\./,
		);
		expect(off.firstSeen.get(id)).toContain("[Result truncated");
	}

	// 2. O aviso de corte nomeia o parâmetro e o próximo valor.
	expect(on.firstSeen.get("d1")).toContain("[Result truncated");
	expect(on.firstSeen.get("d1")).toContain("page=2");
	expect(off.firstSeen.get("d1")).not.toContain("page=2");

	// 3. Avisos de estagnação na 3a e na 5a decisão sem novidade (D2..D6), uma vez cada.
	const nudgeIn = (run: typeof on, index: number, marker: string) =>
		run.systemTexts(run.requests[index]!).some((text) => text.includes(marker));
	// Request i é o prompt da decisão i: o aviso da decisão k aparece a partir do request k+1.
	expect(nudgeIn(on, 4, "Change your approach")).toBe(false);
	expect(nudgeIn(on, 5, "Change your approach")).toBe(true);
	expect(nudgeIn(on, 6, "Stop calling tools")).toBe(false);
	expect(nudgeIn(on, 7, "Stop calling tools")).toBe(true);
	expect(on.systemTexts(on.requests[7]!).filter((text) => text.includes("[Execution note]"))).toHaveLength(2);
	expect(off.requests.some((request) => off.systemTexts(request).some((text) => text.includes("[Execution note]")))).toBe(false);
	// A novidade da página 2 zera a sequência; o run termina normalmente.
	expect(on.checkpoint?.executionLedger?.streak).toBe(0);
	expect(on.checkpoint?.executionLedger?.nudged).toBe(0);

	// 4. Descoberta redundante responde na hora.
	expect(on.firstSeen.get("d3")).toBe("Already loaded: mcp__shop__list_items. Call them directly.");
	expect(off.firstSeen.get("d3")).not.toContain("Already loaded");

	// 5. Números: payload de tool e prompt total caem de forma mensurável.
	const pct = (before: number, after: number) => Math.round((1 - after / before) * 1000) / 10;
	const report = {
		toolPayloadChars: { off: off.toolPayloadChars, on: on.toolPayloadChars, drop: `${pct(off.toolPayloadChars, on.toolPayloadChars)}%` },
		promptChars: { off: off.promptChars, on: on.promptChars, drop: `${pct(off.promptChars, on.promptChars)}%` },
		effectiveInputWithPrefixCache: { off: Math.round(off.effectiveInput), on: Math.round(on.effectiveInput), drop: `${pct(off.effectiveInput, on.effectiveInput)}%` },
		connectorCalls: { off: off.connectorCalls.length, on: on.connectorCalls.length },
	};
	console.log(`[replay F3b] ${JSON.stringify(report)}`);
	// O lote mantém grupos íntegros por até 4 decisões (é o preço do prefixo estável);
	// mesmo assim o payload cai >25% e o custo efetivo com cache cai >40%.
	expect(on.toolPayloadChars).toBeLessThan(off.toolPayloadChars * 0.75);
	expect(on.promptChars).toBeLessThan(off.promptChars);
	expect(on.effectiveInput).toBeLessThan(off.effectiveInput * 0.6);
});

it("replay: com a flag desligada nada muda (sem ledger no checkpoint, sem avisos)", async () => {
	vi.stubEnv("ATLAS_EXECUTION_DISCIPLINE", "off");
	const off = await replay(false);
	// Sem disciplina não há decisões no livro-razão; só o journal de efeitos (F2b) segue gravado.
	expect(off.checkpoint?.executionLedger?.decisions).toEqual([]);
	expect(off.requests.length).toBe(SCRIPT.length + 1);
});

async function resumeRun(executionLedger?: AgentRunCheckpoint["executionLedger"]) {
	const requests: LlmMessage[][] = [];
	let decision = 0;
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-resume",
		userId: "user-a",
		origin: "chat",
		autonomy,
		executionDiscipline: true,
		messages: [{ role: "user", content: "Check the item." }],
		mcp: {
			toolset: buildMcpToolset([connection], { autonomy }),
			call: async () => ({ ok: true, text: "static page", truncated: false }),
		},
		restoredCheckpoint: executionLedger
			? { version: 1, nextStepIndex: 3, messages: [], llmMessages: [], executionLedger }
			: undefined,
		onEvent: () => undefined,
		streamChat: async (params) => {
			requests.push(JSON.parse(JSON.stringify(params.messages)) as LlmMessage[]);
			return decision++ === 0 ? reply([call("r1", "mcp__shop__get_item", { id: "1" })]) : done;
		},
	});
	return requests;
}

it("replay: a sequência sem novidade sobrevive à retomada pelo checkpoint", async () => {
	// Descobre o texto exato que o modelo vê (o runtime embrulha dado externo).
	const probe = await resumeRun();
	const seen = probe[1]!.find((m) => m.role === "tool")!.content as string;
	const requests = await resumeRun({
		v: 1,
		decisions: [],
		seenIds: [],
		seenHashes: [{ hash: contentHash(seen), tool: "mcp__shop__get_item", step: 1 }],
		streak: 2,
		nudged: 0,
		closedStep: 2,
	});
	const isNudge = (m: LlmMessage) => m.role === "system" && typeof m.content === "string" && m.content.includes("Change your approach");
	expect(probe[1]!.some(isNudge)).toBe(false);
	expect(requests[1]!.filter(isNudge)).toHaveLength(1);
});
