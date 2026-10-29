import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { persistConversationCardFromEvent, saveSkillPendingIntent } from "@workspace/db";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { runComputerUse } from "./computer-use.js";

/** Escrita no GitHub fora do app: vira cartão (instalar o app / usar minha conta desta vez); nada é enviado. */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		saveSkillPendingIntent: vi.fn(async () => undefined),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		loadAutonomyContext: vi.fn(async () => ({ accountRaw: null, botRaw: null, botName: "Cookie" })),
	};
});

const github = {
	id: "conn-gh",
	slug: "github",
	name: "GitHub",
	catalogId: "github",
	disabledTools: [],
	tools: [
		{
			name: "issue_write",
			description: "Cria ou edita issue",
			inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" } } },
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
	],
};

const blocked = {
	ok: false,
	text: "O app nao esta instalado. Nada foi enviado.",
	truncated: false,
	githubIdentity: { reason: "not_installed" as const, repo: "exemplo/loja-monorepo", installUrl: "/v1/github-app/install", appName: "meu-app", message: "x" },
};

function toolCall(): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "c1",
					type: "function",
					function: { name: "mcp__github__issue_write", arguments: JSON.stringify({ owner: "exemplo", repo: "loja-monorepo", title: "Bug" }) },
				},
			],
		},
	};
}

async function run(origin: string) {
	const call = vi.fn(async () => blocked);
	const mcp: McpRuntime = {
		toolset: buildMcpToolset([github] as never, { autonomy: { level: "autonomous", exceptions: [] } }),
		call,
	};
	const events: Array<Record<string, unknown> & { type: string }> = [];
	const queue = [toolCall(), { model: "test-model", message: { role: "assistant", content: "ok" } } as CompleteChatWithToolsResult];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("nao deve criar sessao");
		},
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "abre uma issue" }],
		botId: "bot-1",
		userId: "user-1",
		conversationId: "conv-gh",
		runId: "run-gh",
		origin,
		maxSteps: 4,
		mcp,
		autonomy: { level: "autonomous", exceptions: [] },
		onEvent: (event) => void events.push(event as never),
		streamChat: async () => {
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { call, events };
}

describe("cartão de identidade do GitHub no run", () => {
	beforeEach(() => vi.clearAllMocks());

	it("repositório fora do app: cartão só de instalar o app + Pronto (refaz pelo app), sem enviar nada", async () => {
		const { events } = await run("chat");
		const confirm = events.find((e) => e.type === "confirm");
		expect(confirm).toMatchObject({
			confirmLabel: "Pronto, já instalei",
			githubIdentity: { reason: "not_installed", repo: "exemplo/loja-monorepo", installUrl: "/v1/github-app/install" },
		});
		expect(saveSkillPendingIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({
					action: "mcp-call",
					mcpCall: expect.objectContaining({ toolName: "issue_write" }),
				}),
			}),
		);
		expect(persistConversationCardFromEvent).toHaveBeenCalledWith("conv-gh", expect.objectContaining({ githubIdentity: expect.anything() }));
	});

	it("rotina (sem humano): erro explicando, sem cartão e sem cair na conta do usuário", async () => {
		const { events } = await run("routine");
		expect(events.some((e) => e.type === "confirm")).toBe(false);
		expect(saveSkillPendingIntent).not.toHaveBeenCalled();
		const result = events.find((e) => e.type === "tool_result");
		expect(result).toMatchObject({ ok: false });
	});
});
