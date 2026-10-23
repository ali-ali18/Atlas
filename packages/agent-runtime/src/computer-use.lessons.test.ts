import { describe, expect, it, vi } from "vitest";
import { appendedToolNotes } from "./loop/tool-result-notes.js";
import type { AgentRunCheckpoint, ComputerUseEvent, LessonFeedbackEntry } from "@workspace/shared";
import { LESSON_INJECT_MAX_CHARS, LESSON_INJECT_MAX_ITEMS, lessonRef } from "@workspace/shared";
import type { SandboxManager } from "@workspace/sandbox";
import type { ChatTool, CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import { runComputerUse } from "./computer-use.js";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import type { ApiConnectorRuntime } from "./api-connector/runtime.js";
import type { RunLesson, RunLessonsParam } from "./lessons.js";
import { ERP_CONNECTION, EXPOSED, assistantCalls, assistantSays, fakeErp, toolCall } from "./harness-regression.fixtures.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	listConnectedApiConnections: vi.fn(async () => []),
	listMcpConnections: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	searchMemoryEntries: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
}));

const T0 = "2026-10-01T00:00:00.000Z";
function lesson(id: string, over: Partial<RunLesson> = {}): RunLesson {
	return { id, scope: "bot", scopeKey: null, content: `Ao agir ${id}, faça X — porque Y`, helpful: 0, harmful: 0, lastUsedAt: null, updatedAt: T0, createdAt: T0, ...over };
}

type Seen = { messages: LlmMessage[]; tools: string[] };

async function run(steps: CompleteChatWithToolsResult[], extra: { lessons?: RunLessonsParam; mcp?: McpRuntime; apiConnector?: ApiConnectorRuntime; messages?: Array<{ role: "user" | "system" | "assistant"; content: string }> } = {}) {
	const seen: Seen[] = [];
	const queue = [...steps];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "fixture",
		model: "fixture",
		runId: "run-l",
		userId: "owner-l",
		botId: "bot-l",
		conversationId: "conversation-l",
		origin: "chat",
		contextEconomy: false,
		maxSteps: 8,
		autonomy: { level: "autonomous" as const, exceptions: [] },
		messages: [{ role: "user" as const, content: "faça o pedido" }],
		...extra,
		streamChat: async (params: { tools?: ChatTool[]; messages: LlmMessage[] }) => {
			seen.push({ messages: params.messages.map((message) => ({ ...message })), tools: (params.tools ?? []).map((tool) => tool.function.name) });
			return queue.shift() ?? assistantSays("fim");
		},
		onEvent: (_event: ComputerUseEvent) => undefined,
		onCheckpoint: async (_value: AgentRunCheckpoint) => undefined,
		onLoginRequired: vi.fn(),
	}).catch((cause: unknown) => cause);
	return seen;
}

const erp = (): McpRuntime => ({ toolset: buildMcpToolset([ERP_CONNECTION], { autonomy: { level: "autonomous", exceptions: [] } }), call: fakeErp().call });
// Lições entram no início (system) ou, para conector carregado depois, anexadas ao resultado da tool.
const lessonNotes = (messages: LlmMessage[]): LlmMessage[] => [
	...messages.filter((message) => message.role === "system" && typeof message.content === "string" && message.content.startsWith("════ LIÇÕES APRENDIDAS")),
	...appendedToolNotes(messages).filter((note) => note.startsWith("════ LIÇÕES APRENDIDAS")).map((content) => ({ role: "tool" as const, content })),
];
const text = (message: LlmMessage) => String(message.content);

describe("lições no run", () => {
	it("sem lições o pedido não muda: nenhuma nota e a tool lesson_feedback nem aparece", async () => {
		const seen = await run([assistantSays("ok")], { mcp: erp() });
		expect(lessonNotes(seen[0]!.messages)).toHaveLength(0);
		expect(seen[0]!.tools).not.toContain("lesson_feedback");
	});

	it("lições de conector entram ao carregar o conector, só as do conector carregado, uma vez, com o id curto", async () => {
		const injected: Array<{ ids: string[]; key: string }> = [];
		const items = [
			lesson("cmbot0001", { content: "Ao responder, seja breve — porque o usuário pediu" }),
			lesson("cmerp0002", { scope: "connector", scopeKey: "mcp:conn-erp", content: "Ao buscar cliente, use o nome completo — porque a busca é exata" }),
			lesson("cmoth0003", { scope: "connector", scopeKey: "mcp:outro", content: "Ao usar o outro conector, faça Z — porque W" }),
		];
		const seen = await run([assistantCalls(toolCall("c1", EXPOSED.findCustomer, { name: "Exemplo" })), assistantSays("achei")], { mcp: erp(), lessons: { items, onInjected: (info) => void injected.push(info) } });
		const first = lessonNotes(seen[0]!.messages);
		expect(first).toHaveLength(1);
		expect(text(first[0]!)).toContain(`[${lessonRef("cmerp0002")}] Ao buscar cliente`);
		expect(text(first[0]!)).not.toContain("outro conector");
		expect(text(first[0]!)).not.toContain("seja breve");
		expect(text(first[0]!)).toContain("[mcp:conn-erp]");
		// segunda chamada ao modelo: a nota continua uma só
		expect(lessonNotes(seen[seen.length - 1]!.messages)).toHaveLength(1);
		expect(injected).toEqual([{ ids: ["cmerp0002"], key: "mcp:conn-erp" }]);
		expect(seen[0]!.tools).toContain("lesson_feedback");
	});

	it("lição de tool entra quando a tool está carregada", async () => {
		const items = [lesson("cmtool001", { scope: "tool", scopeKey: EXPOSED.createOrder, content: "Ao criar pedido, confirme o prazo — porque o ERP rejeita sem ele" })];
		const seen = await run([assistantSays("ok")], { mcp: erp(), lessons: { items } });
		expect(lessonNotes(seen[0]!.messages).map(text).join("\n")).toContain("confirme o prazo");
	});

	it("o bloco respeita 40 itens e 3000 caracteres", async () => {
		const items = Array.from({ length: 60 }, (_, n) => lesson(`cmcap${String(n).padStart(4, "0")}`, { scope: "connector", scopeKey: "mcp:conn-erp", content: `Ao caso ${n}, ${"x".repeat(80)}` }));
		const seen = await run([assistantSays("ok")], { mcp: erp(), lessons: { items } });
		const note = text(lessonNotes(seen[0]!.messages)[0]!);
		const lines = note.split("\n").filter((line) => line.startsWith("[L"));
		expect(lines.length).toBeLessThanOrEqual(LESSON_INJECT_MAX_ITEMS);
		expect(lines.join("").length).toBeLessThanOrEqual(LESSON_INJECT_MAX_CHARS + lines.length * 8);
	});

	it("prefixo estável: cada pedido ao modelo começa, mensagem a mensagem, com o anterior (a nota só é anexada)", async () => {
		const items = [lesson("cmerp0002", { scope: "connector", scopeKey: "mcp:conn-erp", content: "Ao buscar cliente, use o nome completo — porque a busca é exata" })];
		const seen = await run([assistantCalls(toolCall("c1", EXPOSED.findCustomer, { name: "Exemplo" })), assistantCalls(toolCall("c2", EXPOSED.listItems, {})), assistantSays("fim")], { mcp: erp(), lessons: { items } });
		expect(seen.length).toBeGreaterThanOrEqual(3);
		for (let n = 1; n < seen.length; n += 1) {
			expect(seen[n]!.messages.slice(0, seen[n - 1]!.messages.length)).toEqual(seen[n - 1]!.messages);
			expect(seen[n]!.tools).toEqual(seen[0]!.tools);
		}
	});

	it("retomada: a nota que já está na conversa do checkpoint não é repetida", async () => {
		const items = [lesson("cmerp0002", { scope: "connector", scopeKey: "mcp:conn-erp", content: "Ao buscar cliente, use o nome completo — porque a busca é exata" })];
		const first = await run([assistantSays("ok")], { mcp: erp(), lessons: { items } });
		const note = lessonNotes(first[0]!.messages)[0]!;
		const seen = await run([assistantSays("ok")], { mcp: erp(), lessons: { items }, messages: [{ role: "user", content: "faça o pedido" }, { role: "system", content: text(note) }] });
		expect(lessonNotes(seen[0]!.messages)).toHaveLength(1);
	});

	it("lesson_feedback grava helped/hurt/applied pelo dono e bot do run e confirma ao modelo", async () => {
		const recorded: LessonFeedbackEntry[][] = [];
		const items = [lesson("cmbot0001"), lesson("cmbot0002")];
		const seen = await run(
			[assistantCalls(toolCall("f1", "lesson_feedback", { lessons: [{ id: `[${lessonRef("cmbot0001")}]`, outcome: "helped" }, { id: lessonRef("cmbot0002"), outcome: "hurt" }, { id: "Lzzzz" }] })), assistantSays("pronto")],
			{ lessons: { items, recordFeedback: async (entries) => (recorded.push(entries), { applied: ["cmbot0001", "cmbot0002"], unknown: ["Lzzzz"], retired: [] }) } },
		);
		expect(recorded).toEqual([[{ ref: lessonRef("cmbot0001"), outcome: "helped" }, { ref: lessonRef("cmbot0002"), outcome: "hurt" }, { ref: "Lzzzz", outcome: "applied" }]]);
		const toolMessage = seen[seen.length - 1]!.messages.filter((message) => message.role === "tool").map(text).join("\n");
		expect(toolMessage).toContain("Recorded feedback for 2 lesson(s)");
		expect(toolMessage).toContain("Unknown ids ignored: Lzzzz");
	});

	it("lesson_feedback sem nenhum id válido falha de verdade (ok:false), não finge sucesso", async () => {
		const seen = await run(
			[assistantCalls(toolCall("f1", "lesson_feedback", { lessons: [{ id: "Lzzzz" }] })), assistantSays("pronto")],
			{ lessons: { items: [lesson("cmbot0001")], recordFeedback: async () => ({ applied: [], unknown: ["Lzzzz"], retired: [] }) } },
		);
		const toolMessage = seen[seen.length - 1]!.messages.filter((message) => message.role === "tool").map(text).join("\n");
		expect(toolMessage).toMatch(/no active lesson matched/);
	});
});

describe("lições de conector de API", () => {
	it("entram depois do primeiro uso do conector (como o guia), só as dessa conexão", async () => {
		const api: ApiConnectorRuntime = {
			connections: [{ id: "conn-1", name: "Loja", slug: "loja", domain: "api.loja.test", guide: null }],
			guideFor: () => ({ id: "conn-1", name: "Loja", text: null }),
			search: vi.fn(async () => "listPedidos GET /pedidos"),
			call: vi.fn(async () => "GET /pedidos -> 200\n{}"),
		};
		const items = [
			lesson("cmapi0001", { scope: "connector", scopeKey: "api:conn-1", content: "Ao listar pedidos, filtre por data — porque a lista é enorme" }),
			lesson("cmapi0002", { scope: "connector", scopeKey: "api:outra", content: "Ao usar a outra API, faça Z — porque W" }),
		];
		const seen = await run([assistantCalls(toolCall("a1", "api_call", { operationId: "listPedidos" })), assistantSays("ok")], { apiConnector: api, lessons: { items } });
		expect(lessonNotes(seen[0]!.messages)).toHaveLength(0);
		const notes = lessonNotes(seen[seen.length - 1]!.messages);
		expect(notes).toHaveLength(1);
		expect(text(notes[0]!)).toContain("filtre por data");
		expect(text(notes[0]!)).not.toContain("outra API");
	});
});
