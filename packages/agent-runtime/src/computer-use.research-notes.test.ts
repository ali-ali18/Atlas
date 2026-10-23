import type { JevRuntime } from "./jev/decide.js";
import { appendedToolNotes } from "./loop/tool-result-notes.js";
import { WANTS_FILE_JEV } from "./jev/test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { AgentRunCheckpoint } from "@workspace/shared";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { DELIVERABLE_RESERVE_NOTE, FILE_RESERVE_TOOLS } from "./execution/run-governor.js";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";

/**
 * F3 — research_note: replay de uma pesquisa que chega a 80% do orçamento. As
 * notas (e não novas leituras) alimentam o arquivo. LLM mockado.
 */

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	persistUserArtifact: vi.fn(async (input: { runId: string; kind: string; bytes: Uint8Array; mime: string; meta?: object }) => ({
		id: "art-1",
		kind: input.kind,
		meta: { ...input.meta, mime: input.mime, size: input.bytes.byteLength },
		runId: input.runId,
		conversationId: "conv-notes",
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
type Ev = Record<string, unknown> & { type: string };
type Request = { index: number; offered: string[]; messages: Message[]; layer: string | null };
/** 7 decisões de 0,125 = 0,875 (80%); a 8ª custa 0,05 (0,925 = 90%). */
const COST_OF = (index: number) => (index < 7 ? 0.125 : index === 7 ? 0.05 : 0.01);
const LAYER_HEAD = "Research notes so far";
const layerOf = (messages: Message[]) =>
	messages.map((m) => (m.role === "system" && typeof m.content === "string" && m.content.startsWith(LAYER_HEAD) ? m.content : null)).find(Boolean) ?? null;

async function run(input: {
	message: string;
	driver: (ctx: { index: number; offered: string[]; layer: string | null; events: Ev[] }) => CompleteChatWithToolsResult;
	priorResearchNotes?: unknown;
	checkpoint?: AgentRunCheckpoint;
	jev?: JevRuntime;
}) {
	const requests: Request[] = [];
	const events: Ev[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const readArgs: string[] = [];
	let pages = 0;
	const mcp: McpRuntime = {
		toolset,
		call: vi.fn(async (_name: string, args: unknown) => {
			readArgs.push(JSON.stringify(args));
			return { ok: true, text: `conteúdo da fonte ${"abcdefghijklmnop"[pages++ % 16]} sobre o assunto`, truncated: false };
		}) as unknown as McpRuntime["call"],
	};
	let decision = 0;
	let error: unknown;
	let result: Awaited<ReturnType<typeof runComputerUse>> | undefined;
	try {
		result = await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "unused",
			sandboxEnabled: false,
			apiKey: "test",
			model: "m",
			runId: "run-notes",
			jev: input.jev,
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-notes",
			origin: "chat",
			contextEconomy: true,
			messages: [{ role: "user", content: input.message }],
			maxSteps: 60,
			budget: { maxCostUsd: 1 },
			mcp,
			priorResearchNotes: input.priorResearchNotes,
			restoredCheckpoint: input.checkpoint,
			onCheckpoint: async (checkpoint: AgentRunCheckpoint) => {
				checkpoints.push(JSON.parse(JSON.stringify(checkpoint)));
			},
			onEvent: (event) => {
				events.push(event as never);
			},
			streamChat: async (params) => {
				const messages = JSON.parse(JSON.stringify(params.messages)) as Message[];
				const offered = params.tools.map((tool) => tool.function.name);
				const index = decision++;
				const layer = layerOf(messages);
				requests.push({ index, offered, messages, layer });
				return { ...input.driver({ index, offered, layer, events }), usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: COST_OF(index) } };
			},
		} as never);
	} catch (caught) {
		error = caught;
	}
	return { result, error, requests, events, checkpoints, readArgs };
}

const fileEvents = (events: Ev[]) => events.filter((event) => event.type === "file");
const noteArgs = (n: number) => ({
	sourceRef: `https://example.test/fonte-${n}`,
	findings: `A fonte ${n} estabelece o ponto ${n}.`,
	keyFacts: [`fato-${n}`],
	confidence: "high",
});

describe("F3: research_note em uma pesquisa que chega a 80% do orçamento", () => {
	// Teto de US$ 1: 80% na decisão 7, 90% na decisão 8.
	const driver = ({ index, offered, layer }: { index: number; offered: string[]; layer: string | null }) => {
		if (offered.length > 0 && offered.every((name) => FILE_RESERVE_TOOLS.includes(name))) {
			// O arquivo sai das notas que voltaram na camada, sem reler nada.
			return turn(call(`f${index}`, "create_file", { filename: "relatorio.md", content: `# Relatório\n\n${layer ?? "sem notas"}\n\n## Lacunas\n\nFontes não lidas.` }));
		}
		if (index < 8) return index % 2 === 0 ? turn(call(`r${index}`, "mcp__data__fetch_page", { page: index })) : turn(call(`n${index}`, "research_note", noteArgs(index)));
		return say("Pronto: relatório criado a partir das notas.");
	};

	it("as notas voltam a cada passo e o arquivo sai delas, sem releitura", async () => {
		const { result, error, requests, events, readArgs } = await run({
			message: "pesquisa o assunto a fundo e faz um relatório em pdf",
			jev: WANTS_FILE_JEV,
			driver,
		});
		expect(error).toBeUndefined();
		expect(requests[0]!.offered).toContain("research_note");
		expect(requests[0]!.layer).toBeNull();
		// A partir da primeira nota, a camada aparece em todo passo (higiene de contexto não a remove).
		expect(requests[2]!.layer).toContain("https://example.test/fonte-1");
		expect(requests[5]!.layer).toContain("https://example.test/fonte-1");
		expect(requests[5]!.layer!.indexOf("fonte-5")).toBeLessThan(requests[5]!.layer!.indexOf("fonte-3"));
		// 80%: aviso do governador + a camada pede o arquivo a partir das notas.
		const at80 = requests[7]!;
		expect(appendedToolNotes(at80.messages)).toContain(DELIVERABLE_RESERVE_NOTE);
		expect(at80.layer).toContain("write the requested file now from these notes");
		// Nenhuma leitura repetida.
		expect(new Set(readArgs).size).toBe(readArgs.length);
		expect(fileEvents(events)).toHaveLength(1);
		expect(result?.text).toContain("a partir das notas");
		// O conteúdo do arquivo veio das notas.
		const created = requests
			.flatMap((r) => r.messages)
			.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []) : []))
			.find((c) => c.function.name === "create_file");
		expect(created?.function.arguments).toContain("fato-3");
		expect(created?.function.arguments).toContain("fonte-1");
	});

	it("as notas ficam no checkpoint e a retomada as devolve ao modelo", async () => {
		const first = await run({
			message: "pesquisa o assunto e faz um relatório",
			driver: ({ index }) => (index === 0 ? turn(call("n0", "research_note", noteArgs(1))) : say("Parei aqui.")),
		});
		const saved = first.checkpoints.at(-1)!;
		expect(saved.researchNotes).toHaveLength(1);
		expect(saved.researchNotes?.[0]?.sourceRef).toBe("https://example.test/fonte-1");

		const resumed = await run({
			message: "pesquisa o assunto e faz um relatório",
			checkpoint: saved,
			driver: ({ layer }) => say(layer ?? "sem camada"),
		});
		expect(resumed.result?.text).toContain("https://example.test/fonte-1");
	});

	it("notas de runs anteriores da conversa aparecem em seção própria", async () => {
		const { result } = await run({
			message: "continua a pesquisa",
			priorResearchNotes: [{ sourceRef: "https://example.test/antiga", findings: "achado antigo", keyFacts: [], links: [], confidence: "low", step: 2 }],
			driver: ({ layer }) => say(layer ?? "sem camada"),
		});
		expect(result?.text).toContain("From earlier runs in this conversation:");
		expect(result?.text).toContain("https://example.test/antiga");
	});

	it("sem notas e sem notas anteriores, nenhuma camada é injetada", async () => {
		const { requests } = await run({ message: "oi", driver: () => say("olá") });
		expect(requests.every((request) => request.layer === null)).toBe(true);
	});
});
