import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { TRANSCRIPT_SLOT, type SerializedLlmMessage } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const answer: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "ok" } };

// Turno 1 buscou o cliente; o turno 2 (30 dias) precisa ainda enxergar o resultado.
const prior: SerializedLlmMessage[] = [
	{ role: "user", content: "monte uma proposta para o cliente Alfa" },
	{ role: "assistant", content: "Vou buscar.", tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
	{ role: "tool", tool_call_id: "c1", content: '{"id":42,"name":"Alfa"}' },
	{ role: "assistant", content: "Achei o Alfa. Qual a condição de pagamento?" },
];

async function turnTwo(input: { withSlot: boolean; transcript?: SerializedLlmMessage[] }) {
	let transport: CompleteChatWithToolsParams | undefined;
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		model: "m", apiKey: "test", runId: "run-2", userId: "user-a",
		origin: "chat",
		messages: [
			{ role: "system" as const, content: "identidade do bot" },
			...(input.withSlot ? [{ role: "system" as const, content: TRANSCRIPT_SLOT }] : []),
			{ role: "user" as const, content: "30 dias" },
		],
		priorTranscript: input.transcript,
		sandboxEnabled: false,
		onEvent: () => undefined,
		streamChat: async (params) => { transport = params; return answer; },
	});
	return transport?.messages ?? [];
}

describe("conversa contínua entre turnos", () => {
	it("o resultado de ferramenta do turno 1 chega ao modelo no turno 2, antes do pedido novo", async () => {
		const sent = await turnTwo({ withSlot: true, transcript: prior });
		const roles = sent.map((m) => m.role);
		const toolAt = roles.indexOf("tool");
		expect(toolAt).toBeGreaterThan(0);
		expect(JSON.stringify(sent[toolAt])).toContain("Alfa");
		expect(sent[toolAt - 1]?.tool_calls?.[0]?.id).toBe("c1");
		expect(sent[sent.length - 1]).toMatchObject({ role: "user", content: "30 dias" });
		expect(JSON.stringify(sent)).not.toContain(TRANSCRIPT_SLOT);
	});

	it("sem conversa gravada a marcação some e fica só o histórico de texto", async () => {
		const sent = await turnTwo({ withSlot: true });
		expect(sent.some((m) => m.role === "tool")).toBe(false);
		expect(JSON.stringify(sent)).not.toContain(TRANSCRIPT_SLOT);
	});
});

describe("tools carregadas seguem para o turno seguinte", () => {
	it("loadedTools sobrevive ao checkpoint", async () => {
		const { buildRuntimeCheckpoint, parseRuntimeCheckpoint } = await import("./checkpoint.js");
		const cp = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 1, model: "m", loadedTools: ["mcp__erp__create_proposal", "mcp__erp__find_client"] });
		expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(cp)))?.loadedTools).toEqual(["mcp__erp__create_proposal", "mcp__erp__find_client"]);
		expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify({ ...cp, loadedTools: [1, "ok"] })))?.loadedTools).toEqual(["ok"]);
	});
});

describe("marca d'água da conversa no checkpoint", () => {
	it("sobrevive ao checkpoint e descarta formato inválido", async () => {
		const { buildRuntimeCheckpoint, parseRuntimeCheckpoint } = await import("./checkpoint.js");
		const mark = { messageId: "m9", createdAt: "2026-01-01T00:00:00.000Z", count: 12 };
		const cp = buildRuntimeCheckpoint({ messages: [], conversation: [], nextStepIndex: 1, model: "m", transcriptWatermark: mark });
		expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(cp)))?.transcriptWatermark).toEqual(mark);
		expect(parseRuntimeCheckpoint({ ...cp, transcriptWatermark: { messageId: 1 } })?.transcriptWatermark).toBeUndefined();
	});
});
