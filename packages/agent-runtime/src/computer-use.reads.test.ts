import { streamChatWithTools } from "@workspace/llm";
import { afterEach, expect, it, vi } from "vitest";
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
		{
			name: "search",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
			},
			annotations: { readOnlyHint: true },
		},
		{
			name: "update",
			inputSchema: { type: "object", properties: {} },
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				openWorldHint: false,
			},
		},
	],
};
const toolset = buildMcpToolset([connection], { autonomy });
const read = (id: string, query: string, refresh = false): LlmToolCall => ({
	id,
	type: "function",
	function: {
		name: "mcp__data__search",
		arguments: JSON.stringify({
			query,
			...(refresh ? { runtime_refresh: true } : {}),
		}),
	},
});
const response = (calls: LlmToolCall[]): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: calls },
});
const done: CompleteChatWithToolsResult = {
	model: "m",
	message: { role: "assistant", content: "Concluído." },
};
const base = {
	manager: {} as SandboxManager,
	getSessionId: async () => "unused",
	sandboxEnabled: false,
	apiKey: "test",
	model: "m",
	runId: "run-a",
	userId: "user-a",
	origin: "chat",
	autonomy,
	messages: [{ role: "user" as const, content: "Busque os dados e atualize." }],
};

it("L1/L2: cache/ref, refresh e escrita em barreira; resultados duráveis por item", async () => {
	let active = 0,
		maximum = 0;
	const persisted = new Map<string, { ok: boolean; summary: string }>();
	const events: string[] = [];
	const calls = [
		read("a", "a"),
		read("b", "b"),
		read("c", "c"),
		read("duplicate", "a"),
		read("poll", "a", true),
		{
			id: "write",
			type: "function" as const,
			function: { name: "mcp__data__update", arguments: "{}" },
		},
		read("after-write", "a"),
	];
	const connector = vi.fn(
		async (name: string, args: Record<string, unknown>) => {
			active++;
			maximum = Math.max(maximum, active);
			if (name.endsWith("update")) expect(active).toBe(1);
			await new Promise((resolve) =>
				setTimeout(resolve, args.query === "a" ? 8 : 1),
			);
			active--;
			return {
				ok: true,
				text: `payload-${args.query ?? "write"}`,
				truncated: false,
			};
		},
	);
	let iteration = 0;
	let checkpoint: AgentRunCheckpoint | undefined;
	await runComputerUse({
		...base,
		mcp: { toolset, call: connector },
		maxSteps: 4,
		onEvent: (event) => {
			if (event.type === "tool_result") events.push(event.summary);
		},
		onStep: async (step) => {
			if (step.type === "tool_result") {
				const output = step.outputJson as { ok: boolean; summary: string };
				persisted.set(step.idempotencyKey, output);
			}
		},
		findCompletedTool: async (key) => persisted.get(key) ?? null,
		onCheckpoint: async (value) => {
			checkpoint = value;
		},
		streamChat: async (params) => {
			if (iteration++ === 0) {
				expect(
					params.tools.find(
						(tool) => tool.function.name === "mcp__data__search",
					)?.function.parameters.properties,
				).toHaveProperty("runtime_refresh");
				return response(calls);
			}
			if (iteration === 2) {
				const ref = [...persisted.keys()].find((key) => key.includes(":a:"))!;
				return response([
					{
						id: "details",
						type: "function",
						function: {
							name: "read_cached_result",
							arguments: JSON.stringify({ result_ref: ref }),
						},
					},
				]);
			}
			return done;
		},
	});
	expect(maximum).toBe(3);
	expect(connector).toHaveBeenCalledTimes(6);
	expect(
		connector.mock.calls.every(([, args]) => !("runtime_refresh" in args)),
	).toBe(true);
	expect(events.some((summary) => summary.includes("result_ref:"))).toBe(true);
	expect(events.at(-1)).toContain("payload-a");
	expect(persisted.size).toBe(8);
	const toolIds = checkpoint?.llmMessages
		?.filter((message) => message.role === "tool")
		.map((message) => message.tool_call_id);
	expect(toolIds?.slice(0, 7)).toEqual(calls.map((call) => call.id));
});

it("L2: resume executa somente itens sem resultado persistido", async () => {
	const calls = [read("a", "a"), read("b", "b"), read("c", "c")];
	const connector = vi.fn(
		async (_name: string, _args: Record<string, unknown>) => ({
			ok: true,
			text: "payload-c",
			truncated: false,
		}),
	);
	await runComputerUse({
		...base,
		mcp: { toolset, call: connector },
		restoredCheckpoint: {
			version: 1,
			nextStepIndex: 0,
			messages: [],
			llmMessages: [
				{ role: "assistant", content: null, tool_calls: calls },
				{ role: "tool", tool_call_id: "a", content: "payload-a" },
			],
		},
		findCompletedTool: async (key) =>
			key.includes(":b:") ? { ok: true, summary: "payload-b" } : null,
		onEvent: () => undefined,
		streamChat: async () => done,
	});
	expect(connector).toHaveBeenCalledTimes(1);
	expect(connector.mock.calls[0]?.[1]).toEqual({ query: "c" });
});

it("L8: inicialização recebe sinal do run e cancelamento impede ação seguinte", async () => {
	const controller = new AbortController();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const navigate = vi.fn(async () => ({
		url: "https://example.test",
		title: "x",
	}));
	const manager = { execNavigate: navigate } as Partial<SandboxManager>;
	let received: AbortSignal | undefined;
	const result = runComputerUse({
		...base,
		messages: [{ role: "user" as const, content: "Abra o site e busque os dados." }],
		manager: manager as SandboxManager,
		sandboxEnabled: true,
		abortSignal: controller.signal,
		getSessionId: async (execution) => {
			received = execution?.signal;
			started();
			return new Promise<string>(() => undefined);
		},
		onEvent: () => undefined,
		streamChat: async () =>
			response([
				{
					id: "navigate",
					type: "function",
					function: {
						name: "navigate",
						arguments: JSON.stringify({ url: "https://example.test" }),
					},
				},
			]),
	});
	const rejected = expect(result).rejects.toThrow();
	await ready;
	controller.abort();
	await rejected;
	expect(received?.aborted).toBe(true);
	expect(navigate).not.toHaveBeenCalled();
});

it("L1: duas descobertas vazias deixam orientação durável para parar a busca", async () => {
	const summaries: string[] = [];
	let decision = 0;
	await runComputerUse({
		...base,
		mcp: {
			toolset,
			call: async () => ({ ok: true, text: "unused", truncated: false }),
		},
		onEvent: () => undefined,
		onStep: async (step) => {
			if (step.type === "tool_result")
				summaries.push((step.outputJson as { summary: string }).summary);
		},
		streamChat: async () =>
			++decision <= 2
				? response([
						{
							id: `discovery-${decision}`,
							type: "function",
							function: {
								name: "mcp_tool_search",
								arguments: '{"query":"capability_that_does_not_exist"}',
							},
						},
					])
				: done,
	});
	expect(summaries[0]).not.toContain("Repeated empty discovery");
	expect(summaries[1]).toContain("Do not repeat this search");
});

it("N6: descoberta vazia antes da retomada conta para a próxima", async () => {
	const summaries: string[] = [];
	let decision = 0;
	await runComputerUse({
		...base,
		mcp: {
			toolset,
			call: async () => ({ ok: true, text: "unused", truncated: false }),
		},
		restoredCheckpoint: {
			version: 1,
			nextStepIndex: 1,
			messages: [],
			llmMessages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "previous",
							type: "function",
							function: {
								name: "mcp_tool_search",
								arguments: '{"query":"missing"}',
							},
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "previous",
					content: 'Nenhuma tool encontrada para "missing".',
				},
			],
		},
		onEvent: () => undefined,
		onStep: async (step) => {
			if (step.type === "tool_result")
				summaries.push((step.outputJson as { summary: string }).summary);
		},
		streamChat: async () =>
			++decision === 1
				? response([
						{
							id: "next",
							type: "function",
							function: {
								name: "mcp_tool_search",
								arguments: '{"query":"also_missing"}',
							},
						},
					])
				: done,
	});
	expect(summaries[0]).toContain("Do not repeat this search");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it("N4: reasoning configurado não falha quando o saldo do run reduz a saída", async () => {
	vi.stubEnv("LLM_REASONING_MAX_TOKENS", "2048");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toMatchObject({
				max_tokens: 64,
				reasoning: { max_tokens: 32 },
			});
			return new Response(
				'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			);
		}),
	);
	await runComputerUse({
		...base,
		budget: { maxTokens: 64 },
		maxOutputTokens: 4096,
		onEvent: () => undefined,
		streamChat: streamChatWithTools,
	});
});
