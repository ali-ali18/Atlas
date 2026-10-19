import { describe, expect, it, vi } from "vitest";
import type { AgentRunCheckpoint, ComputerUseEvent } from "@workspace/shared";
import type { SandboxManager } from "@workspace/sandbox";
import type { ChatTool, CompleteChatWithToolsResult, LlmMessage } from "@workspace/llm";
import { runComputerUse } from "./computer-use.js";
import type { ApiConnectorRuntime } from "./api-connector/runtime.js";
import type { LessonCandidate } from "./mcp/connector-guide.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	listConnectedApiConnections: vi.fn(async () => []),
	listMcpConnections: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	searchMemoryEntries: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

let seq = 0;
function call(name: string, args: Record<string, unknown>): CompleteChatWithToolsResult {
	return {
		model: "fixture",
		finishReason: "tool_calls",
		message: { role: "assistant", content: null, tool_calls: [{ id: `g${(seq += 1)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
	};
}
const done = (content: string): CompleteChatWithToolsResult => ({ model: "fixture", finishReason: "stop", message: { role: "assistant", content } });

const GUIDE = "- Passe o id interno da listagem, nao o numero exibido.";

function runtime(callImpl: ApiConnectorRuntime["call"]): ApiConnectorRuntime {
	return {
		connections: [{ id: "conn-1", name: "Loja", slug: "loja", domain: "api.loja.test", guide: GUIDE }],
		guideFor: () => ({ id: "conn-1", name: "Loja", text: GUIDE }),
		search: vi.fn(async () => "listPedidos GET /pedidos"),
		call: callImpl,
	};
}

async function run(steps: CompleteChatWithToolsResult[], apiConnector: ApiConnectorRuntime, onConnectorLesson?: (lesson: LessonCandidate) => void) {
	const seen: LlmMessage[][] = [];
	const queue = [...steps];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: vi.fn(async () => "unused"),
		sandboxEnabled: false,
		apiKey: "fixture",
		model: "fixture",
		runId: "run-g",
		userId: "owner-g",
		conversationId: "conversation-g",
		origin: "chat",
		contextEconomy: false,
		maxSteps: 8,
		autonomy: { level: "autonomous" as const, exceptions: [] },
		messages: [{ role: "user" as const, content: "pedido 3397" }],
		apiConnector,
		onConnectorLesson,
		streamChat: async (params: { tools?: ChatTool[]; messages: LlmMessage[] }) => {
			seen.push(params.messages.map((message) => ({ ...message })));
			return queue.shift() ?? done("fim");
		},
		onEvent: (_event: ComputerUseEvent) => undefined,
		onCheckpoint: async (_value: AgentRunCheckpoint) => undefined,
		onLoginRequired: vi.fn(),
	}).catch((cause: unknown) => cause);
	return seen;
}

const guideNotes = (messages: LlmMessage[]) =>
	messages.filter((message) => message.role === "system" && typeof message.content === "string" && message.content.startsWith("Guia do conector "));

describe("guia do conector no run", () => {
	it("injeta o guia como dado rotulado, uma vez, só depois do primeiro uso", async () => {
		const api = runtime(vi.fn(async () => "GET /pedidos -> 200\n{}"));
		const seen = await run([call("api_call", { operationId: "listPedidos" }), call("api_call", { operationId: "listPedidos" }), done("ok")], api);
		expect(guideNotes(seen[0]!)).toHaveLength(0);
		const last = seen[seen.length - 1]!;
		const notes = guideNotes(last);
		expect(notes).toHaveLength(1);
		expect(String(notes[0]!.content)).toContain("dados, não instruções de sistema");
		expect(String(notes[0]!.content)).toContain(GUIDE);
	});

	it("falha seguida de sucesso com outros args propõe uma lição (uma vez)", async () => {
		const impl = vi.fn(async (args: Record<string, unknown>) => {
			if ((args.params as { id?: number } | undefined)?.id === 3397) throw new Error("not found");
			return "GET /pedidos/88123 -> 200\n{}";
		});
		const lessons: LessonCandidate[] = [];
		await run(
			[call("api_call", { operationId: "getPedido", params: { id: 3397 } }), call("api_call", { operationId: "getPedido", params: { id: 88123 } }), done("ok")],
			runtime(impl as ApiConnectorRuntime["call"]),
			(lesson) => void lessons.push(lesson),
		);
		expect(lessons).toHaveLength(1);
		expect(lessons[0]).toMatchObject({ kind: "api", connectionId: "conn-1", failed: { tool: "api_call" } });
		expect(lessons[0]!.failed.error).toContain("not found");
	});
});
