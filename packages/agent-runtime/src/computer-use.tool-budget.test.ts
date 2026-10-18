import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { ComputerUseEvent } from "@workspace/shared";
import { buildRuntimeCheckpoint, parseRuntimeCheckpoint } from "./checkpoint.js";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		searchMemoryEntries: async () => [],
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
	};
});

vi.mock("./github/hook-sync.js", () => ({
	ensureGithubRepoHook: vi.fn(async () => ({ ok: true })),
}));

const github = {
	id: "conn-gh",
	slug: "github",
	name: "GitHub",
	disabledTools: [],
	confirmWrites: false,
	tools: [
		{
			name: "get_file_contents",
			description: "Lê arquivo ou pasta",
			inputSchema: { type: "object", properties: { path: { type: "string" } } },
			annotations: { readOnlyHint: true },
		},
		{
			name: "create_issue",
			description: "Cria issue",
			inputSchema: { type: "object", properties: { title: { type: "string" } } },
			annotations: { readOnlyHint: false },
		},
	],
};

const READ = "mcp__github__get_file_contents";
const WRITE = "mcp__github__create_issue";

function step(
	name: string,
	id: string,
	args: Record<string, unknown>,
): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: [
				{ id, type: "function", function: { name, arguments: JSON.stringify(args) } },
			],
		},
	};
}

const done: CompleteChatWithToolsResult = {
	model: "test-model",
	message: { role: "assistant", content: "Pronto" },
};

async function run(input: {
	queue: CompleteChatWithToolsResult[];
	call?: McpRuntime["call"];
	budget?: { maxCallsPerTool?: Record<string, number> };
	restoredCheckpoint?: ReturnType<typeof parseRuntimeCheckpoint>;
	onCheckpoint?: (checkpoint: unknown) => void;
}) {
	const events: ComputerUseEvent[] = [];
	const call: McpRuntime["call"] =
		input.call ??
		(async (_name, args) => ({
			ok: true,
			text: `conteudo de ${JSON.stringify(args)}`,
			truncated: false,
		}));
	const autonomy = { level: "autonomous" as const, exceptions: [] };
	const queue = [...input.queue];
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("nao deve criar sessao");
		},
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "leia o repo" }],
		runId: "run-tool-budget",
		maxSteps: 100,
		// Sem fase de avaliação soft (24 passos) atrapalhando o replay longo.
		budget: { softMaxSteps: 100, ...input.budget },
		autonomy,
		mcp: { toolset: buildMcpToolset([github], { autonomy }), call },
		restoredCheckpoint: input.restoredCheckpoint ?? undefined,
		onCheckpoint: input.onCheckpoint
			? async (checkpoint) => input.onCheckpoint?.(checkpoint)
			: undefined,
		onEvent: (event) => {
			events.push(event);
		},
		streamChat: async () => {
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { result, events };
}

const results = (events: ComputerUseEvent[]) =>
	events.filter((e) => e.type === "tool_result") as Array<
		Extract<ComputerUseEvent, { type: "tool_result" }>
	>;
const extensions = (events: ComputerUseEvent[]) =>
	events.filter((e) => e.type === "tool_budget_extended") as Array<
		Extract<ComputerUseEvent, { type: "tool_budget_extended" }>
	>;

describe("teto adaptativo de tools MCP", () => {
	it("45 leituras distintas passam de 40 e emitem uma única extensão", async () => {
		const call = vi.fn<McpRuntime["call"]>(async (_name, args) => ({
			ok: true,
			text: `conteudo de ${JSON.stringify(args)}`,
			truncated: false,
		}));
		const queue = Array.from({ length: 45 }, (_, i) =>
			step(READ, `c${i}`, { path: `src/file-${i}.ts` }),
		);
		const { events } = await run({ queue: [...queue, done], call });
		const toolResults = results(events);
		expect(toolResults).toHaveLength(45);
		expect(toolResults.every((r) => r.ok)).toBe(true);
		expect(call).toHaveBeenCalledTimes(45);
		expect(extensions(events)).toEqual([
			{
				type: "tool_budget_extended",
				tool: READ,
				connectorName: "GitHub",
				from: 40,
				to: 60,
			},
		]);
	});

	it("leitura repetindo os mesmos args para no teto com dica em inglês", async () => {
		const queue = Array.from({ length: 41 }, (_, i) =>
			step(READ, `c${i}`, { path: `f${i % 4}` }),
		);
		const { events } = await run({ queue: [...queue, done] });
		const toolResults = results(events);
		expect(extensions(events)).toHaveLength(0);
		const last = toolResults[toolResults.length - 1];
		expect(last?.ok).toBe(false);
		expect(last?.summary).toMatch(/Call limit of 40/);
		expect(last?.summary).toMatch(/list\/search tools/);
	});

	it("tool de escrita continua parando em 10", async () => {
		const call = vi.fn<McpRuntime["call"]>(async () => ({
			ok: true,
			text: "criada",
			truncated: false,
		}));
		const queue = Array.from({ length: 11 }, (_, i) =>
			step(WRITE, `w${i}`, { title: `issue ${i}` }),
		);
		const { events } = await run({ queue: [...queue, done], call });
		expect(call).toHaveBeenCalledTimes(10);
		expect(extensions(events)).toHaveLength(0);
		expect(results(events)[10]?.ok).toBe(false);
	});

	it("teto explícito do bot é fixo, mesmo para leitura", async () => {
		const call = vi.fn<McpRuntime["call"]>(async () => ({
			ok: true,
			text: "x",
			truncated: false,
		}));
		const queue = Array.from({ length: 13 }, (_, i) =>
			step(READ, `c${i}`, { path: `f${i}` }),
		);
		const { events } = await run({
			queue: [...queue, done],
			call,
			budget: { maxCallsPerTool: { [READ]: 12 } },
		});
		expect(call).toHaveBeenCalledTimes(12);
		expect(extensions(events)).toHaveLength(0);
	});

	it("resume mantém teto ampliado e histórico", async () => {
		const history = Array.from({ length: 10 }, (_, i) => ({
			argsHash: `h${i}`,
			ok: true,
		}));
		const stored = parseRuntimeCheckpoint(
			buildRuntimeCheckpoint({
				messages: [{ role: "user", content: "leia o repo" }],
				conversation: [{ role: "user", content: "leia o repo" }],
				nextStepIndex: 3,
				model: "test-model",
				toolCallCounts: { [READ]: 60 },
				toolCallHistory: { [READ]: history },
				toolCapExtensions: { [READ]: 60 },
			}),
		);
		expect(stored?.toolCapExtensions).toEqual({ [READ]: 60 });
		expect(stored?.toolCallHistory?.[READ]).toHaveLength(10);
		const { events } = await run({
			queue: [step(READ, "r1", { path: "novo.ts" }), done],
			restoredCheckpoint: stored,
		});
		expect(results(events)[0]?.ok).toBe(true);
		expect(extensions(events)).toEqual([
			expect.objectContaining({ from: 60, to: 90 }),
		]);
	});

	it("checkpoint persiste histórico e tetos ampliados", async () => {
		let last: unknown;
		const queue = Array.from({ length: 41 }, (_, i) =>
			step(READ, `c${i}`, { path: `f${i}` }),
		);
		await run({
			queue: [...queue, done],
			onCheckpoint: (checkpoint) => {
				last = checkpoint;
			},
		});
		const parsed = parseRuntimeCheckpoint(last);
		expect(parsed?.toolCapExtensions?.[READ]).toBe(60);
		expect(parsed?.toolCallHistory?.[READ]).toHaveLength(10);
	});
});
