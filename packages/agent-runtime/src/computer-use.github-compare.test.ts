import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { getGithubConnectionToken } from "./mcp/github-token.js";
import { getComposioGithubContext } from "./github/hook-ops.js";

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		findCoveringGithubInstallation: vi.fn(async () => null),
		listGithubInstallationsForUser: vi.fn(async () => []),
	};
});

vi.mock("./github/hook-ops.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./github/hook-ops.js")>();
	return { ...actual, getComposioGithubContext: vi.fn(async () => null) };
});

vi.mock("./mcp/github-token.js", () => ({
	getGithubConnectionToken: vi.fn(),
	markGithubConnectionAuthFailed: vi.fn(async () => undefined),
}));

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

const done = (): CompleteChatWithToolsResult => ({ model: "test-model", message: { role: "assistant", content: "pronto" } });

function commit(n: number) {
	return {
		sha: `${String(n).padStart(2, "0")}${"c".repeat(38)}`,
		commit: { message: `ajuste ${n}`, author: { name: "Ana" } },
		author: { login: "ana" },
	};
}

describe("tool github_compare", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getComposioGithubContext).mockResolvedValue(null);
		vi.mocked(getGithubConnectionToken).mockResolvedValue({ token: "gho_x", source: "oauth" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = String(input);
				const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
				if (url.includes("/compare/")) {
					const page = Number(new URL(url).searchParams.get("page"));
					const all = Array.from({ length: 120 }, (_, i) => commit(i + 1));
					return json({
						status: "ahead",
						ahead_by: 120,
						total_commits: 120,
						commits: page === 1 ? all.slice(0, 100) : all.slice(100),
						files: page === 1 ? [{ filename: "a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@" }] : [],
					});
				}
				return json({ stats: { additions: 2, deletions: 1 }, files: [{}] });
			}),
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	async function run(args: Record<string, unknown>) {
		const results: Array<{ name: string; ok: boolean; summary: string }> = [];
		const queue = [toolCall("c1", "github_compare", args), done()];
		await runComputerUse({
			manager: {} as unknown as SandboxManager,
			getSessionId: async () => "s",
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "quantos commits teve o push?" }],
			runId: "run-compare",
			conversationId: "conv-compare",
			botId: "bot-1",
			userId: "user-real",
			maxSteps: 4,
			onEvent: (event) => {
				if (event.type === "tool_result") results.push(event);
			},
			streamChat: async () => {
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
		});
		return results;
	}

	it("devolve TODOS os commits (2 páginas), compactos, com a lista antes dos arquivos e sem patch", async () => {
		const results = await run({ repo: "acme/site", base: "main", head: "feat" });
		expect(results[0]?.ok).toBe(true);
		const text = results[0]!.summary;
		expect(text).toContain("commits=120 listed=120");
		for (const n of [1, 100, 101, 120]) expect(text).toContain(`\n${n}. `);
		expect(text.indexOf("COMMITS:")).toBeLessThan(text.indexOf("FILES:"));
		expect(text).not.toContain("@@");
		expect(text.length).toBeLessThan(18_001);
	});

	it("valida os argumentos (repo no formato owner/name) com ok:false", async () => {
		const results = await run({ repo: "nao-e-repo", base: "a", head: "b" });
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.summary).toContain("owner/name");
	});

	it("sem nenhuma conexão -> ok:false pedindo conectar", async () => {
		vi.mocked(getGithubConnectionToken).mockResolvedValue({ error: "Conecte o GitHub no Marketplace" });
		const results = await run({ repo: "acme/site", base: "a", head: "b" });
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.summary).toContain("Conecte o GitHub");
	});
});
