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

async function run(input: Partial<Parameters<typeof runComputerUse>[0]>) {
	const calls: CompleteChatWithToolsParams[] = [];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		model: "anthropic/claude-sonnet-5.5",
		apiKey: "test",
		runId: "run-reasoning",
		userId: "user-a",
		conversationId: "conv-1",
		origin: "chat",
		messages: [{ role: "user", content: "oi" }],
		sandboxEnabled: false,
		onEvent: () => undefined,
		streamChat: async (params): Promise<CompleteChatWithToolsResult> => {
			calls.push(params);
			return { model: params.model, message: { role: "assistant", content: "ok" } };
		},
		...input,
	});
	return calls;
}

describe("nível de raciocínio no laço do agente", () => {
	it("chega ao streamChat quando o modelo tem suporte", async () => {
		const calls = await run({ reasoningEffort: "high", modelSupportsReasoning: () => true });
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((call) => call.reasoningEffort === "high")).toBe(true);
	});
	it("modelo sem suporte não recebe o parâmetro", async () => {
		const calls = await run({ model: "openai/gpt-4o", reasoningEffort: "high", modelSupportsReasoning: () => false });
		expect(calls.every((call) => !("reasoningEffort" in call))).toBe(true);
	});
	it("sem escolha, nada é enviado", async () => {
		const calls = await run({});
		expect(calls.every((call) => !("reasoningEffort" in call))).toBe(true);
	});
});
