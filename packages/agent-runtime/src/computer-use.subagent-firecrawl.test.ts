import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { buildChildToolFilter, selectChildMcpPreactivation, selectChildWebConnectorTools } from "@workspace/shared";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { runComputerUse } from "./computer-use.js";

/**
 * Regressão: filho com catálogo adiado (tools começam vazias) precisa nascer com o
 * Firecrawl, usando os nomes expostos reais (`mcp__firecrawl__firecrawl_*`), a
 * conexão vinda do catálogo (sem `readOnlyHint`) e o mesmo caminho do delegate_task.
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

const REAL_FIRECRAWL_TOOLS = [
	"firecrawl_scrape",
	"firecrawl_map",
	"firecrawl_search",
	"firecrawl_crawl",
	"firecrawl_agent",
	"firecrawl_interact",
	"firecrawl_parse",
	"firecrawl_monitor_create",
	"firecrawl_credit_usage",
];

const firecrawl = {
	id: "conn-fc",
	slug: "firecrawl",
	name: "Firecrawl",
	catalogId: "firecrawl",
	disabledTools: [],
	tools: REAL_FIRECRAWL_TOOLS.map((name) => ({
		name,
		description: `Firecrawl ${name}`,
		inputSchema: { type: "object", properties: {} },
	})),
};

describe("subagente recebe o Firecrawl (catálogo adiado)", () => {
	it("nasce com scrape/search read-only e sem as demais", async () => {
		const mcp: McpRuntime = {
			toolset: buildMcpToolset([firecrawl], {
				autonomy: { level: "autonomous", exceptions: [] },
				maxTools: 1,
			}),
			call: vi.fn(async () => ({ ok: true, text: "x", truncated: false })),
		};
		expect(mcp.toolset.deferred).toBe(true);
		expect(mcp.toolset.tools).toEqual([]);

		const toolFilter = buildChildToolFilter({
			requested: undefined,
			webConnectorTools: selectChildWebConnectorTools(
				[...mcp.toolset.entries].map(([name, entry]) => ({ name, readOnly: entry.readOnly })),
			),
			isMcpName: (name) => name.startsWith("mcp__"),
			isMcpReadOnly: (name) => mcp.toolset.entries.get(name)?.readOnly,
		});
		const preactivateMcpTools = selectChildMcpPreactivation({
			parentActive: [],
			entries: [...mcp.toolset.entries].map(([name, entry]) => ({ name, readOnly: entry.readOnly })),
		}).filter(toolFilter);
		expect(preactivateMcpTools).toEqual(
			expect.arrayContaining(["mcp__firecrawl__firecrawl_scrape", "mcp__firecrawl__firecrawl_search"]),
		);

		const seen: string[][] = [];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("sandbox nao deve ser usado");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "pesquise" }],
			botId: "bot-1",
			userId: "user-1",
			runId: "child-fc",
			origin: "subagent",
			maxSteps: 4,
			mcp,
			autonomy: { level: "autonomous", exceptions: [] },
			toolFilter,
			preactivateMcpTools,
			onEvent: () => undefined,
			streamChat: async (params) => {
				seen.push(params.tools.map((tool) => tool.function.name));
				return { model: "test-model", message: { role: "assistant", content: "ok" } } satisfies CompleteChatWithToolsResult;
			},
		});
		expect(seen[0]).toEqual(
			expect.arrayContaining([
				"mcp_tool_search",
				"mcp__firecrawl__firecrawl_scrape",
				"mcp__firecrawl__firecrawl_search",
			]),
		);
		// Reserva para quando os créditos do Firecrawl acabam.
		expect(seen[0]).toEqual(expect.arrayContaining(["web_search", "web_extract"]));
		expect(seen[0]).not.toContain("mcp__firecrawl__firecrawl_agent");
		expect(seen[0]).not.toContain("mcp__firecrawl__firecrawl_monitor_create");
	});
});
