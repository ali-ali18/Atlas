import type { JevRuntime } from "./jev/decide.js";
import { WANTS_FILE_JEV } from "./jev/test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { AgentRunCheckpoint } from "@workspace/shared";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { FILE_RESERVE_TOOLS } from "./execution/run-governor.js";
import { createNarrationMemory, mentionsFileDeliverable, STALL_ABORT_AT, STALL_NUDGE_AT, STALL_NUDGE_NOTE, STALL_RESTRICT_AT, STALL_RESTRICT_NOTE, stallStage } from "./execution/stall-guard.js";
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
const COST_OF = (_index: number) => 0.001;
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

describe("pesquisa anterior -> PDF", () => {
	it("o arquivo pedido numa nova mensagem recebe TODAS as notas da pesquisa anterior", async () => {
		const prior = Array.from({ length: 12 }, (_, i) => ({
			sourceRef: `https://example.test/doc-${i + 1}`,
			findings: `Seção ${i + 1}: achado detalhado ${"x".repeat(300)}`,
			keyFacts: [`fato-${i + 1}`],
			links: [],
			confidence: "high",
			step: i,
		}));
		const { requests, events } = await run({
			message: "faz um pdf da pesquisa",
			priorResearchNotes: prior,
			driver: ({ index, layer }) =>
				index === 0 ? turn(call("f0", "create_file", { filename: "pesquisa.md", content: layer ?? "" })) : say("Pronto."),
		});
		const layer = requests[0]!.layer!;
		for (let i = 1; i <= 12; i++) expect(layer).toContain(`doc-${i}:`);
		expect(fileEvents(events)).toHaveLength(1);
	});
});

describe("enrolação lendo fontes sem gerar o arquivo", () => {
	const narrations = [
		"Você tem razão, o PDF anterior ficou raso. Vou refazer com o que as fontes que li trazem.",
		"Vou ler as duas fontes principais antes de refazer o PDF, para ele ter mais conteúdo confirmado.",
		"Você tem razão: o PDF ficou curto demais. Vou buscar mais detalhe nas fontes oficiais e refazer o arquivo.",
		"Vou buscar mais detalhes nas fontes oficiais para montar um PDF completo.",
		"Vou buscar mais detalhes nas fontes oficiais antes de refazer o PDF.",
	];
	const spin = ({ index }: { index: number }): CompleteChatWithToolsResult => ({
		model: "m",
		message: {
			role: "assistant",
			content: narrations[index % narrations.length]!,
			tool_calls: [call(`r${index}`, "mcp__data__fetch_page", { page: index })],
		},
	});

	it("avisa, restringe às tools de arquivo e para com mensagem honesta, sem rodar para sempre", async () => {
		const { requests, error, events } = await run({ message: "ficou curto, refaz o pdf com mais conteúdo", driver: spin });
		expect(error).toBeDefined();
		expect((error as Error).name).toBe("AgentRunLoopDetectedError");
		// Para antes do teto de passos (60): os limiares de enrolação mandam.
		expect(requests.length).toBeLessThan(30);
		const notes = (index: number) => requests[index]!.messages.filter((m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[Execution note]"));
		expect(notes(STALL_NUDGE_AT + 1).some((m) => m.content === STALL_NUDGE_NOTE)).toBe(true);
		expect(notes(STALL_RESTRICT_AT + 1).some((m) => m.content === STALL_RESTRICT_NOTE)).toBe(true);
		expect(requests[STALL_RESTRICT_AT + 1]!.offered.every((name) => FILE_RESERVE_TOOLS.includes(name))).toBe(true);
		// Falas repetidas viram um balão só: o resto é retirado.
		expect(events.filter((event) => event.type === "assistant_discard").length).toBeGreaterThan(5);
	});

	it("pesquisa legítima (sem pedido de arquivo) não é cortada pela guarda", async () => {
		const { error, requests } = await run({
			message: "pesquisa o assunto a fundo",
			driver: ({ index }) => (index < 22 ? spin({ index }) : say("Resumo da pesquisa.")),
		});
		expect(error).toBeUndefined();
		expect(requests.length).toBe(23);
	});
});

describe("stall-guard (puro)", () => {
	it("limiares escalonados", () => {
		expect(stallStage(STALL_NUDGE_AT - 1)).toBe("ok");
		expect(stallStage(STALL_NUDGE_AT)).toBe("nudge");
		expect(stallStage(STALL_RESTRICT_AT)).toBe("restrict");
		expect(stallStage(STALL_ABORT_AT)).toBe("abort");
	});
	it("detecta falas quase iguais e não confunde falas diferentes", () => {
		const memory = createNarrationMemory();
		memory.remember("Vou buscar mais detalhes nas fontes oficiais para montar um PDF completo.");
		expect(memory.isDuplicate("Vou buscar mais detalhes nas fontes oficiais antes de refazer o PDF.")).toBe(true);
		expect(memory.isDuplicate("Achei o preço na tabela de planos e vou comparar com o concorrente.")).toBe(false);
	});
	it("pedido de arquivo nas falas recentes do usuário", () => {
		expect(mentionsFileDeliverable(["pesquisa x", "agora um PDF", "ficou curto"])).toBe(true);
		expect(mentionsFileDeliverable(["pesquisa x", "e o preço?"])).toBe(false);
	});
});
