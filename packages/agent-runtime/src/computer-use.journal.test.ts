import { expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmMessage, LlmToolCall } from "@workspace/llm";
import type { ComputerUseEvent } from "@workspace/shared";
import { runComputerUse, seedToolOutcomes, type CompletedToolReplay } from "./computer-use.js";
import { collapseOldToolGroups } from "./hygiene.js";
import { INTERRUPTED_WRITE_NOTE } from "./execution/journal.js";
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
const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const WRITE = "mcp__data__update";
const READ = "mcp__data__search";
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "All set." } };
const base = {
	manager: {} as SandboxManager,
	getSessionId: async () => "unused",
	sandboxEnabled: false,
	apiKey: "test",
	model: "m",
	runId: "run-j",
	userId: "user-a",
	origin: "chat",
	autonomy,
	messages: [{ role: "user" as const, content: "Do the work." }],
};
const resumeFrom = (calls: LlmToolCall[], tools: LlmMessage[] = []) => ({
	version: 2,
	nextStepIndex: 0,
	messages: [],
	llmMessages: [{ role: "assistant" as const, content: null, tool_calls: calls }, ...tools] as never,
});

it("W9: intent is recorded before the write and the result carries a structured status", async () => {
	const order: string[] = [];
	const steps: Array<{ type: string; status?: string; inputJson?: unknown; outputJson?: unknown }> = [];
	let decision = 0;
	await runComputerUse({
		...base,
		mcp: {
			toolset,
			call: async () => {
				order.push("connector");
				return { ok: true, text: "written", truncated: false };
			},
		},
		onEvent: () => undefined,
		onStep: async (step) => {
			steps.push(step);
			if (step.type === "tool") order.push(`intent:${(step.inputJson as { attemptId?: string }).attemptId ? "durable" : "plain"}`);
		},
		streamChat: async () =>
			decision++ === 0
				? { model: "m", message: { role: "assistant", content: null, tool_calls: [call("w1", WRITE, { value: "x" })] } }
				: done,
	});
	expect(order).toEqual(["intent:durable", "connector"]);
	const result = steps.find((step) => step.type === "tool_result" && step.status === "completed");
	expect((result?.outputJson as { status: unknown }).status).toEqual({ status: "ok", effect: "applied" });
});

it("W9: crash between intent and result -> uncertain, never auto-repeated, and stays so on the next resume", async () => {
	const connector = vi.fn(async () => ({ ok: true, text: "written", truncated: false }));
	const stored = new Map<string, { status: string; outputJson: { summary: string; ok: boolean; status: never } }>();
	const requests: LlmMessage[][] = [];
	const run = () =>
		runComputerUse({
			...base,
			mcp: { toolset, call: connector },
			restoredCheckpoint: resumeFrom([call("w1", WRITE, { value: "x" })]),
			// A tentativa anterior gravou a intenção e caiu antes do resultado.
			findStartedTool: async (key) => (stored.has(key) ? null : { attemptId: key, tool: WRITE }),
			findCompletedTool: async (key): Promise<CompletedToolReplay | null> => {
				const row = stored.get(key);
				return row ? { summary: row.outputJson.summary, ok: row.outputJson.ok, status: row.outputJson.status } : null;
			},
			onStep: async (step) => {
				if (step.type === "tool_result") stored.set(step.idempotencyKey, step as never);
			},
			onEvent: () => undefined,
			streamChat: async (params) => {
				requests.push(JSON.parse(JSON.stringify(params.messages)) as LlmMessage[]);
				return done;
			},
		});
	await run();
	expect(connector).not.toHaveBeenCalled();
	const toolMessage = requests[0]!.find((message) => message.role === "tool");
	expect(toolMessage?.content).toBe(INTERRUPTED_WRITE_NOTE);
	const saved = [...stored.values()][0]!;
	expect(saved.status).toBe("failed");
	expect(saved.outputJson.status).toMatchObject({ status: "uncertain", effect: "uncertain" });

	// Segunda retomada: o resultado incerto é reaproveitado, ainda sem repetir.
	await run();
	expect(connector).not.toHaveBeenCalled();
});

it("W9: a write that times out is recorded as uncertain and not retried", async () => {
	const connector = vi.fn(async () => ({ ok: false, text: "request timed out", truncated: false, uncertain: true }));
	const steps: Array<{ type: string; status?: string; outputJson?: unknown }> = [];
	let decision = 0;
	await runComputerUse({
		...base,
		mcp: { toolset, call: connector },
		onEvent: () => undefined,
		onStep: async (step) => {
			steps.push(step);
		},
		streamChat: async () =>
			decision++ === 0
				? { model: "m", message: { role: "assistant", content: null, tool_calls: [call("w1", WRITE, {})] } }
				: done,
	});
	expect(connector).toHaveBeenCalledTimes(1);
	const result = steps.find((step) => step.type === "tool_result");
	expect(result?.status).toBe("failed");
	expect((result?.outputJson as { status: unknown }).status).toMatchObject({ status: "uncertain", effect: "uncertain" });
});

it("W9: a read with a dangling running step is simply re-executed", async () => {
	const connector = vi.fn(async () => ({ ok: true, text: "found", truncated: false }));
	await runComputerUse({
		...base,
		mcp: { toolset, call: connector },
		restoredCheckpoint: resumeFrom([call("r1", READ, { query: "q" })]),
		findStartedTool: async (key) => ({ attemptId: key, tool: READ }),
		onEvent: () => undefined,
		streamChat: async () => done,
	});
	expect(connector).toHaveBeenCalledTimes(1);
});

it("L2: parallel reads persist one by one; resume runs only the missing ones", async () => {
	const calls = [call("a", READ, { query: "a" }), call("b", READ, { query: "b" }), call("c", READ, { query: "c" })];
	const connector = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ ok: true, text: `payload-${args.query}`, truncated: false }));
	// "a" já está no checkpoint; "b" gravado só no passo; "c" ficou sem resultado.
	await runComputerUse({
		...base,
		mcp: { toolset, call: connector },
		restoredCheckpoint: resumeFrom(calls, [{ role: "tool", tool_call_id: "a", content: "payload-a" }]),
		findCompletedTool: async (key) => (key.includes(":b:") ? { ok: true, summary: "payload-b" } : null),
		onEvent: () => undefined,
		streamChat: async () => done,
	});
	expect(connector).toHaveBeenCalledTimes(1);
	expect(connector.mock.calls[0]?.[1]).toEqual({ query: "c" });
});

it("W9: replay of a created file re-delivers the card without recreating the file", async () => {
	const events: ComputerUseEvent[] = [];
	const file = { type: "file" as const, artifactId: "art-1", filename: "r.txt", mime: "text/plain", size: 3, format: "text" as const, version: 1 };
	await runComputerUse({
		...base,
		restoredCheckpoint: resumeFrom([call("f1", "create_file", { filename: "r.txt", format: "text", content: "abc" })]),
		findCompletedTool: async () => ({ ok: true, summary: "File created: r.txt", status: { status: "ok", effect: "applied" }, file }),
		onEvent: (event) => {
			events.push(event);
		},
		streamChat: async () => done,
	});
	expect(events.filter((event) => event.type === "file")).toEqual([file]);
});

it("L20: resume reads the structured status, not text prefixes", () => {
	const conversation: LlmMessage[] = [
		{ role: "assistant", content: null, tool_calls: [call("e1", WRITE, {}), call("e2", READ, { query: "q" })] },
		// Texto de falha de conector não começa com "error"; e o de sucesso pode começar.
		{ role: "tool", tool_call_id: "e1", content: "[Data] something went wrong" },
		{ role: "tool", tool_call_id: "e2", content: "Error codes table: 404, 500" },
	];
	const withStatus = seedToolOutcomes(conversation, (id) =>
		id === "e1" ? { status: "error", effect: "none" } : { status: "ok", effect: "none" },
	);
	expect(withStatus.map((item) => item.ok)).toEqual([false, true]);
	// Checkpoint antigo (sem status) mantém o comportamento anterior.
	expect(seedToolOutcomes(conversation).map((item) => item.ok)).toEqual([true, false]);
});

it("L20: hygiene collapse keeps the structured status visible", () => {
	const messages: LlmMessage[] = [
		{ role: "assistant", content: null, tool_calls: [call("e1", WRITE, {})] },
		{ role: "tool", tool_call_id: "e1", content: "[Data] failed hard" },
		{ role: "user", content: "next" },
		{ role: "assistant", content: null, tool_calls: [call("e2", READ, {})] },
		{ role: "tool", tool_call_id: "e2", content: "fine" },
	];
	const { messages: collapsed } = collapseOldToolGroups(messages, 1, (id) => (id === "e1" ? "error" : "ok"));
	const first = collapsed.find((message) => message.tool_call_id === "e1");
	expect(String(first?.content)).toContain("[status: error]");
	expect(String(collapsed.find((message) => message.tool_call_id === "e2")?.content)).toBe("fine");
});
