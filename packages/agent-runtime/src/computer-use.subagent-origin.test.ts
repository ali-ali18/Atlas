import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { buildChildToolFilter } from "@workspace/shared";
import { getBotProfile } from "@workspace/db";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { runComputerUse } from "./computer-use.js";

/**
 * F5 — `toolFilter` e `origin: "subagent"` no runComputerUse. LLM mockado.
 */

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

function toolCall(id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
		},
	};
}

const done = (): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: { role: "assistant", content: "Relatório." },
});

const github = {
	id: "conn-gh",
	slug: "github",
	name: "GitHub",
	disabledTools: [],
	tools: [
		{
			name: "list_prs",
			description: "Lista PRs",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
		},
		{
			name: "create_note",
			description: "Cria nota",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
	],
};
const slack = {
	id: "conn-sl",
	slug: "slack",
	name: "Slack",
	disabledTools: [],
	tools: [
		{
			name: "read_channel",
			description: "Lê canal",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
		},
	],
};

function childFilter(mcp: McpRuntime, requested?: string[]) {
	return buildChildToolFilter({
		requested,
		isMcpName: (name) => name.startsWith("mcp__"),
		isMcpReadOnly: (name) => mcp.toolset.entries.get(name)?.readOnly,
	});
}

async function runChild(input: {
	calls: CompleteChatWithToolsResult[];
	requested?: string[];
	origin?: string;
	useFilter?: boolean;
	maxTools?: number;
}) {
	const call = vi.fn(async () => ({ ok: true, text: "dados", truncated: false }));
	const mcp: McpRuntime = {
		toolset: buildMcpToolset([github, slack], {
			autonomy: { level: "autonomous", exceptions: [] },
			unattended: true,
			maxTools: input.maxTools,
		}),
		call,
	};
	const seenTools: string[][] = [];
	const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
	const queue = [...input.calls];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("sandbox nao deve ser usado");
		},
		sandboxEnabled: true,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "pesquise e me lembra amanhã" }],
		botId: "bot-1",
		userId: "user-1",
		runId: "child-1",
		origin: input.origin ?? "subagent",
		maxSteps: 6,
		mcp,
		autonomy: { level: "autonomous", exceptions: [] },
		toolFilter: input.useFilter === false ? undefined : childFilter(mcp, input.requested),
		onEvent: (event) => {
			if (event.type === "tool_result") toolResults.push(event);
		},
		streamChat: async (params) => {
			seenTools.push(params.tools.map((tool) => tool.function.name));
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { call, seenTools, toolResults };
}

describe("origin subagent + toolFilter (F5)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("o filho não vê propose_*, delegate_task, sandbox, memory de escrita nem rotinas", async () => {
		const { seenTools } = await runChild({ calls: [done()] });
		const names = seenTools[0] ?? [];
		expect(names).toEqual(
			expect.arrayContaining(["web_search", "web_extract", "memory_search", "session_search", "mcp__github__list_prs", "mcp__slack__read_channel"]),
		);
		for (const forbidden of ["delegate_task", "propose_routine", "propose_profile_update", "propose_questionnaire", "propose_skill", "delete_skill", "navigate", "browser_click", "screenshot", "memory", "list_routines", "skill_read", "github_list_repos", "set_autonomy", "mcp__github__create_note"]) {
			expect(names, forbidden).not.toContain(forbidden);
		}
		expect(getBotProfile).not.toHaveBeenCalled();
	});

	it("toolFilter por prefixo restringe as tools MCP e as nativas", async () => {
		const { seenTools } = await runChild({ calls: [done()], requested: ["mcp__github__"] });
		// research_note é do filho por padrão (as notas voltam no relatório); o resto segue o pedido.
		expect(seenTools[0]).toEqual(["research_note", "mcp__github__list_prs"]);
	});

	it("tool alucinada (fora do que foi exposto) vira erro e não executa", async () => {
		const { call, toolResults } = await runChild({
			calls: [
				toolCall("c1", "propose_routine", { title: "x" }),
				toolCall("c2", "mcp__github__create_note", {}),
				toolCall("c3", "delegate_task", { tasks: [{ goal: "x" }] }),
				done(),
			],
		});
		expect(call).not.toHaveBeenCalled();
		expect(toolResults.map((r) => [r.name, r.ok])).toEqual([
			["propose_routine", false],
			["mcp__github__create_note", false],
			["delegate_task", false],
		]);
		expect(toolResults[0]?.summary).toContain("not available to this sub-agent");
	});

	it("catálogo adiado: mcp_tool_search só ativa tools permitidas pelo filtro", async () => {
		const { seenTools, call } = await runChild({
			maxTools: 1,
			requested: ["mcp__github__"],
			calls: [
				toolCall("c1", "mcp_tool_search", { query: "create_note" }),
				toolCall("c2", "mcp_tool_search", { query: "list_prs" }),
				toolCall("c3", "mcp__github__list_prs", {}),
				done(),
			],
		});
		const finalTools = seenTools[seenTools.length - 1] ?? [];
		expect(finalTools).not.toContain("mcp__github__create_note");
		expect(finalTools).not.toContain("mcp__slack__read_channel");
		expect(call).toHaveBeenCalledWith("mcp__github__list_prs", {}, expect.any(AbortSignal), { refresh: false });
	});

	it("sem toolFilter o run comum segue igual (nenhuma tool a menos)", async () => {
		const withoutFilter = await runChild({ calls: [done()], origin: "chat", useFilter: false });
		expect(withoutFilter.seenTools[0]).toContain("propose_routine");
		expect(withoutFilter.seenTools[0]).toContain("mcp__github__create_note");
	});
});
