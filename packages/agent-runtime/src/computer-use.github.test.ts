import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { getGithubConnectionToken } from "./mcp/github-token.js";
import { listUserRepos } from "./github/client.js";
import { getComposioGithubContext } from "./github/hook-ops.js";

vi.mock("./github/hook-ops.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./github/hook-ops.js")>();
	return { ...actual, getComposioGithubContext: vi.fn(async () => null) };
});

vi.mock("./mcp/github-token.js", () => ({
	getGithubConnectionToken: vi.fn(),
	markGithubConnectionAuthFailed: vi.fn(async () => undefined),
}));

vi.mock("./github/client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./github/client.js")>();
	return {
		...actual,
		listUserRepos: vi.fn(),
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

function assistantDone(): CompleteChatWithToolsResult {
	return { model: "test-model", message: { role: "assistant", content: "pronto" } };
}

describe("F1 honestidade: github_list_repos", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getComposioGithubContext).mockResolvedValue(null);
	});

	async function runGithubListRepos(query = "monorepo loja-exemplo") {
		const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
		const queue: CompleteChatWithToolsResult[] = [
			toolCall("c1", "github_list_repos", { query }),
			assistantDone(),
		];
		await runComputerUse({
			manager: {} as unknown as SandboxManager,
			getSessionId: async () => "session-gh",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "crie uma rotina para os meus repos do github" }],
			runId: "run-github-honesty",
			conversationId: "conv-github-honesty",
			botId: "bot-1",
			userId: "user-real",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "tool_result") toolResults.push(event);
			},
			streamChat: async () => {
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		return toolResults;
	}

	it("sem conexão → ok:false (não ok:true com texto de erro)", async () => {
		vi.mocked(getGithubConnectionToken).mockResolvedValue({ error: "Conecte o GitHub no Marketplace" });
		const toolResults = await runGithubListRepos();
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.ok).toBe(false);
		expect(toolResults[0]?.summary).toContain("Conecte o GitHub no Marketplace");
		expect(listUserRepos).not.toHaveBeenCalled();
	});

	it("401 da API → ok:false pedindo reconexão", async () => {
		vi.mocked(getGithubConnectionToken).mockResolvedValue({ token: "t", source: "pat" });
		vi.mocked(listUserRepos).mockResolvedValue({ error: { status: 401, message: "Bad credentials" } });
		const toolResults = await runGithubListRepos();
		expect(toolResults[0]?.ok).toBe(false);
		expect(toolResults[0]?.summary).toContain("Reconecte o GitHub no Marketplace");
	});

	it("sucesso continua ok:true listando repos", async () => {
		vi.mocked(getGithubConnectionToken).mockResolvedValue({ token: "t", source: "pat" });
		vi.mocked(listUserRepos).mockResolvedValue({
			data: [
				{ fullName: "acme/loja-monorepo", private: false, defaultBranch: "main", pushedAt: "2026-01-01T00:00:00Z" },
			],
		});
		const toolResults = await runGithubListRepos("loja-exemplo");
		expect(toolResults[0]?.ok).toBe(true);
		expect(toolResults[0]?.summary).toContain("loja-monorepo");
	});

	function composioCtx(executeTool: ReturnType<typeof vi.fn>) {
		vi.mocked(getComposioGithubContext).mockResolvedValue({
			client: { executeTool, listConnectedAccounts: vi.fn() } as never,
			composioUser: "u",
			connectedAccountId: "ca_1",
			apiKey: "cmp_secret_key",
		});
	}

	it("sem nativo, usa o GitHub do Composio (nativo não é chamado)", async () => {
		vi.mocked(getGithubConnectionToken).mockResolvedValue({ error: "Conecte o GitHub no Marketplace ou pelo Composio" });
		const executeTool = vi.fn(async () => ({
			successful: true,
			error: null,
			data: { details: [{ full_name: "acme/loja-monorepo", private: false, default_branch: "main", pushed_at: "2026-01-01T00:00:00Z" }] },
		}));
		composioCtx(executeTool);
		const toolResults = await runGithubListRepos("loja-exemplo");
		expect(toolResults[0]?.ok).toBe(true);
		expect(toolResults[0]?.summary).toContain("acme/loja-monorepo");
		expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ slug: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER" }));
		expect(listUserRepos).not.toHaveBeenCalled();
		expect(JSON.stringify(toolResults)).not.toContain("cmp_secret_key");
	});

	it("401 do Composio → pede reconexão no Composio, sem marcar conexão nativa", async () => {
		vi.mocked(getGithubConnectionToken).mockResolvedValue({ error: "Conecte o GitHub no Marketplace ou pelo Composio" });
		const { ComposioApiError } = await import("./mcp/composio/client.js");
		composioCtx(vi.fn(async () => { throw new ComposioApiError("O Composio respondeu com erro", 401); }));
		const toolResults = await runGithubListRepos();
		expect(toolResults[0]?.ok).toBe(false);
		expect(toolResults[0]?.summary).toContain("Reconecte o GitHub no Composio");
	});
});
