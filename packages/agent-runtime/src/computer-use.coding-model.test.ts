import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
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

type DevSessionParam = NonNullable<Parameters<typeof runComputerUse>[0]["devSession"]>;

/** Sessão de código ativa na conversa (ou nenhuma), sem container: só o `attach` é usado. */
function devSession(active: boolean): DevSessionParam {
	return {
		config: { enabled: true },
		store: { findForConversation: async () => (active ? { id: "sess-1", todos: [] } : null) },
		provider: {},
		getGithubToken: async () => ({ ok: false }),
	} as unknown as DevSessionParam;
}

async function run(input: { active: boolean; codingModel?: string | null; contextOf?: Record<string, number> }) {
	const calls: CompleteChatWithToolsParams[] = [];
	const events: Array<{ type: string; model?: string }> = [];
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		model: "normal/model",
		apiKey: "test",
		runId: "run-coding",
		userId: "user-a",
		conversationId: "conv-1",
		origin: "chat",
		messages: [{ role: "user", content: "corrige o teste" }],
		sandboxEnabled: false,
		devSession: devSession(input.active),
		codingModel: input.codingModel,
		contextLength: 128_000,
		getModelContextLength: async (id) => input.contextOf?.[id] ?? null,
		onEvent: (event) => {
			events.push(event as { type: string; model?: string });
		},
		streamChat: async (params): Promise<CompleteChatWithToolsResult> => {
			calls.push(params);
			return { model: params.model, message: { role: "assistant", content: "ok" } };
		},
	});
	return { calls, events, result };
}

describe("modelo para código no início do run", () => {
	it("com sessão de código ativa, o run usa o modelo para código", async () => {
		const { calls, result } = await run({ active: true, codingModel: "coding/model", contextOf: { "coding/model": 200_000 } });
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((call) => call.model === "coding/model")).toBe(true);
		expect(result.model).toBe("coding/model");
	});

	it("o medidor de contexto informa o modelo em uso", async () => {
		const { events } = await run({ active: true, codingModel: "coding/model" });
		const usage = events.find((event) => event.type === "context_usage");
		expect(usage?.model).toBe("coding/model");
	});

	it("sem sessão de código o modelo normal segue valendo", async () => {
		const { calls } = await run({ active: false, codingModel: "coding/model" });
		expect(calls.every((call) => call.model === "normal/model")).toBe(true);
	});

	it("sem modelo para código configurado nada muda", async () => {
		const { calls } = await run({ active: true, codingModel: null });
		expect(calls.every((call) => call.model === "normal/model")).toBe(true);
	});
});
