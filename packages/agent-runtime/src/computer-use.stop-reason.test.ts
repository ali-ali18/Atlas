import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { stopReasonOfBudget, stopReasonOfLoop } from "@workspace/shared";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { AgentRunLoopDetectedError, BudgetExhaustedError } from "./errors.js";
import { runComputerUse } from "./computer-use.js";

/** F0 do ADR 0002: o runtime devolve (ou lança) o motivo de término sem mudar o comportamento do run. LLM mockado. */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
	};
});

const connection = {
	id: "conn-gh",
	slug: "github",
	name: "GitHub",
	disabledTools: [],
	tools: [
		{
			name: "list_prs",
			description: "Lista PRs",
			inputSchema: { type: "object", properties: { page: { type: "number" } } },
			annotations: { readOnlyHint: true },
		},
	],
};

function toolStep(id: string, args: Record<string, unknown>): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: [{ id, type: "function", function: { name: "mcp__github__list_prs", arguments: JSON.stringify(args) } }],
		},
	};
}

const answer = (): CompleteChatWithToolsResult => ({ model: "test-model", message: { role: "assistant", content: "Pronto." } });

function run(input: { script: (n: number) => CompleteChatWithToolsResult; maxSteps?: number }) {
	const mcp: McpRuntime = {
		toolset: buildMcpToolset([connection], { autonomy: { level: "autonomous", exceptions: [] }, unattended: true }),
		call: vi.fn(async () => ({ ok: true, text: "mesmo resultado", truncated: false })),
	};
	let n = 0;
	return runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("sandbox nao deve ser usado");
		},
		sandboxEnabled: true,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "liste os PRs" }],
		botId: "bot-1",
		userId: "user-1",
		runId: "run-1",
		origin: "chat",
		maxSteps: input.maxSteps ?? 12,
		mcp,
		autonomy: { level: "autonomous", exceptions: [] },
		onEvent: () => undefined,
		streamChat: async () => input.script((n += 1)),
	});
}

describe("motivo de término no runtime", () => {
	it("resposta normal devolve answered", async () => {
		const result = await run({ script: () => answer() });
		expect(result.stop).toEqual({ reason: "answered" });
	});

	it("mesma chamada repetida sem progresso lança trava de loop classificada", async () => {
		const error = await run({ script: (n) => toolStep(`c${n}`, { page: 1 }) }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AgentRunLoopDetectedError);
		expect(stopReasonOfLoop((error as AgentRunLoopDetectedError).kind)).toBe("loop_repeat");
	});

	it("teto de passos com progresso lança BudgetExhaustedError com o kind", async () => {
		const error = await run({ script: (n) => toolStep(`c${n}`, { page: n }), maxSteps: 3 }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BudgetExhaustedError);
		expect(["budget_steps", "budget_stalled"]).toContain(stopReasonOfBudget((error as BudgetExhaustedError).kind));
	});
});
