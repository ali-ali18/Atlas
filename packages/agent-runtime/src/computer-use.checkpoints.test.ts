import { expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { AgentRunCheckpoint } from "@workspace/shared";
import { runComputerUse } from "./computer-use.js";
import { buildMcpToolset } from "./mcp/registry.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const autonomy = { level: "autonomous" as const, exceptions: [] };
const connection = {
	id: "conn-a",
	slug: "data",
	name: "Data",
	disabledTools: [],
	tools: [
		{ name: "search", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
		{ name: "update", inputSchema: { type: "object", properties: { value: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: false } },
	],
};
const toolset = buildMcpToolset([connection], { autonomy });
const READ = "mcp__data__search";
const WRITE = "mcp__data__update";
const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const turn = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: calls },
});
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "All set." } };

async function run(script: CompleteChatWithToolsResult[]) {
	const checkpoints: AgentRunCheckpoint[] = [];
	const decisionAtWrite: number[] = [];
	let decision = 0;
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => "unused",
		sandboxEnabled: false,
		apiKey: "test",
		model: "m",
		runId: "run-l9",
		userId: "user-a",
		origin: "chat",
		autonomy,
		messages: [{ role: "user", content: "Do the work." }],
		mcp: { toolset, call: async () => ({ ok: true, text: "result", truncated: false }) },
		onEvent: () => undefined,
		onCheckpoint: async (checkpoint) => {
			checkpoints.push(JSON.parse(JSON.stringify(checkpoint)) as AgentRunCheckpoint);
			decisionAtWrite.push(decision);
		},
		streamChat: async () => script[Math.min(decision++, script.length - 1)]!,
	});
	return { checkpoints, decisionAtWrite };
}

it("L9: decisões só de leitura gravam UM checkpoint por decisão (antes eram 6+ por passo)", async () => {
	const { checkpoints } = await run([
		turn(call("a", READ, { query: "one" }), call("b", READ, { query: "two" }), call("c", READ, { query: "three" })),
		turn(call("d", READ, { query: "four" })),
		done,
	]);
	// 1º passo de run novo (conversa inicial + snapshot) + fim da decisão 0 + fim da decisão 1 + conclusão.
	expect(checkpoints).toHaveLength(4);
	// O último checkpoint traz as 4 respostas de tool: nada se perde ao gravar menos.
	const last = checkpoints.at(-1)!;
	const toolMessages = (last.llmMessages ?? []).filter((message) => message.role === "tool");
	expect(toolMessages).toHaveLength(4);
});

it("L9: escrita externa grava a chamada ANTES de executar (journal), mais um no fim do passo", async () => {
	const { checkpoints } = await run([turn(call("w1", WRITE, { value: "x" })), done]);
	// início do run novo + antes da escrita + fim do passo + conclusão
	expect(checkpoints).toHaveLength(4);
	// O checkpoint de antes da escrita já tem a chamada do assistente, ainda sem resposta de tool.
	const beforeEffect = checkpoints[1]!;
	const messages = beforeEffect.llmMessages ?? [];
	expect(messages.at(-1)).toMatchObject({ role: "assistant" });
	expect(messages.some((message) => message.role === "tool")).toBe(false);
});
