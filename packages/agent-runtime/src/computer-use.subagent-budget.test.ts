import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendedToolNotes } from "./loop/tool-result-notes.js";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { createSubagentRun } from "@workspace/db";
import { SUBAGENT_SYSTEM_PROMPT } from "./tools/subagent-prompt.js";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { CHILD_WRAPUP_NOTE } from "./subagent-budget.js";
import { runComputerUse } from "./computer-use.js";

/**
 * Reserva de relatório do subagente: nota de fechamento, resumo pela chamada
 * reservada, relatório de emergência e corte dos resultados. LLM mockado.
 */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		createSubagentRun: vi.fn(),
		finishSubagentRun: vi.fn(async () => true),
		failOrphanSubagentRuns: vi.fn(async () => 0),
		appendAgentStep: vi.fn(async () => undefined),
	};
});

type Ev = Record<string, unknown> & { type: string };

const STEP_TOKENS = 14_000;
// Filho sem janela conhecida: piso de 400k (ver planChildBudget).
const CHILD_TOKEN_BUDGET = 400_000;

function toolCalls(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: calls.map((call) => ({
				id: call.id,
				type: "function" as const,
				function: { name: call.name, arguments: JSON.stringify(call.args) },
			})),
		},
	};
}

const say = (content: string): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: { role: "assistant", content },
});

const isChild = (params: CompleteChatWithToolsParams) => {
	const first = params.messages[0];
	return typeof first?.content === "string" && first.content.includes("focused sub-agent");
};
const lastText = (params: CompleteChatWithToolsParams) => {
	const last = params.messages[params.messages.length - 1];
	return typeof last?.content === "string" ? last.content : "";
};

const github = {
	id: "conn-gh",
	slug: "github",
	name: "GitHub",
	disabledTools: [],
	tools: [
		{
			name: "read_things",
			description: "Lê",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
		},
	],
};

const delegateRead = toolCalls([
	{ id: "d1", name: "delegate_task", args: { tasks: [{ goal: "Email 3 semanas", tools: ["mcp__github__read_things"] }] } },
]);

type ChildCall = { toolChoice: unknown; notes: number; toolMessages: string[] };

/** Filho que lê sem parar (14k tokens por passo); o resumo final é configurável. */
async function runReader(opts: { summary: () => CompleteChatWithToolsResult; mcpText?: string }) {
	const mcp: McpRuntime = {
		toolset: buildMcpToolset([github], { autonomy: { level: "autonomous", exceptions: [] } }),
		call: vi.fn(async () => ({
			ok: true,
			text: opts.mcpText ?? "Assunto: fatura de agosto. Remetente: banco.",
			truncated: false,
		})),
	};
	const events: Ev[] = [];
	const childCalls: ChildCall[] = [];
	let parentCalls = 0;
	let reads = 0;
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("sandbox nao deve ser usado");
		},
		sandboxEnabled: true,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "resume meus emails das últimas 3 semanas" }],
		botId: "bot-1",
		userId: "user-1",
		runId: "run-parent",
		origin: "chat",
		maxSteps: 8,
		mcp,
		onEvent: (event) => {
			events.push(event as unknown as Ev);
		},
		streamChat: async (params, handlers) => {
			if (!isChild(params)) {
				parentCalls += 1;
				return parentCalls === 1 ? delegateRead : say("Resumo do pai.");
			}
			if (lastText(params).includes("AVALIAÇÃO DE PROGRESSO")) return say("sem json");
			childCalls.push({
				toolChoice: params.toolChoice,
				notes: params.messages.filter((m) => m.role === "system" && m.content === CHILD_WRAPUP_NOTE).length + appendedToolNotes(params.messages).filter((note) => note === CHILD_WRAPUP_NOTE).length,
				toolMessages: params.messages.filter((m) => m.role === "tool").map((m) => String(m.content)),
			});
			if (params.toolChoice === "none") {
				const reply = opts.summary();
				if (reply.message.content) handlers?.onDelta?.(reply.message.content);
				return reply;
			}
			reads += 1;
			const reply = toolCalls([{ id: `r${reads}`, name: "mcp__github__read_things", args: { q: reads } }]);
			return { ...reply, usage: { promptTokens: STEP_TOKENS - 500, completionTokens: 500, totalTokens: STEP_TOKENS } };
		},
	});
	const delegateResult = events.find((e) => e.type === "tool_result" && e.name === "delegate_task");
	return { events, childCalls, report: String(delegateResult?.summary) };
}

describe("reserva de orçamento do subagente", () => {
	let childCounter = 0;
	beforeEach(() => {
		vi.clearAllMocks();
		childCounter = 0;
		vi.mocked(createSubagentRun).mockImplementation(async () => ({ id: `child-${++childCounter}` }));
	});

	it("filho perto do limite recebe a nota de fechamento uma única vez", async () => {
		const { childCalls } = await runReader({ summary: () => say("Resumo final.") });
		expect(Math.max(...childCalls.map((call) => call.notes))).toBe(1);
		// Só depois de 75% (300k / 14k = 22 passos); antes, nenhuma.
		const first = childCalls.findIndex((call) => call.notes > 0);
		expect(first).toBeGreaterThanOrEqual(20);
		expect(childCalls.slice(0, first).every((call) => call.notes === 0)).toBe(true);
	});

	it("no teto reservado para de usar tools e gera o relatório pela chamada reservada", async () => {
		const { childCalls, report, events } = await runReader({ summary: () => say("Resumo: 3 faturas, total R$ 900.") });
		expect(childCalls[childCalls.length - 1]?.toolChoice).toBe("none");
		const withTools = childCalls.filter((call) => call.toolChoice !== "none").length;
		// Nunca passa do teto reservado (85% + o último passo).
		expect(withTools * STEP_TOKENS).toBeLessThanOrEqual(CHILD_TOKEN_BUDGET * 0.85 + STEP_TOKENS);
		expect(events.find((e) => e.type === "subagent_done")).toMatchObject({ status: "partial" });
		expect(report).toContain("Resumo: 3 faturas, total R$ 900.");
		expect(report).not.toContain("no findings gathered");
	});

	it("se o resumo falha, o relatório de emergência traz os achados das tools", async () => {
		const { report } = await runReader({
			summary: () => {
				throw new Error("provider caiu");
			},
		});
		expect(report).not.toContain("no findings gathered");
		expect(report).toContain("Raw findings");
		expect(report).toContain("mcp__github__read_things: Assunto: fatura de agosto.");
	});

	it("resultado de tool entregue ao filho é cortado em 8k com marcador", async () => {
		const { childCalls } = await runReader({ summary: () => say("ok"), mcpText: "x".repeat(20_000) });
		const tool = childCalls[1]?.toolMessages[0] ?? "";
		expect(tool).toMatch(/\[truncated \d+ chars\]$/);
		expect(tool.length).toBeLessThan(8_100 + 40);
	});

	it("prompt do filho orienta buscar antes de ler", () => {
		expect(SUBAGENT_SYSTEM_PROMPT).toContain("First list or search");
		expect(SUBAGENT_SYSTEM_PROMPT).toContain("at most 10");
	});
});
