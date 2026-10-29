import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGithubWriteSettings, getStrictMcpConnection, listGithubInstallationsForUser, loadEffectiveAutonomy } from "@workspace/db";
import { callMcpTool } from "./call.js";
import { executeConfirmedMcpCall } from "./runtime.js";

vi.mock("@workspace/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@workspace/db")>()),
	getStrictMcpConnection: vi.fn(),
	loadEffectiveAutonomy: vi.fn(),
	getGithubWriteSettings: vi.fn(),
	listGithubInstallationsForUser: vi.fn(),
	getGithubAppConfigRecord: vi.fn(async () => null),
}));
vi.mock("./call.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./call.js")>()),
	callMcpTool: vi.fn(async () => ({ ok: true, text: "feito", truncated: false })),
}));

const call = { userId: "user-a", botId: "bot-a", connectionId: "conn-a", toolName: "create_event", exposedName: "mcp__calendar__create_event", args: { summary: "Reunião" } };
const record = {
	id: "conn-a", slug: "calendar", name: "Agenda", url: "https://example.com/mcp",
	catalogId: null, authType: "none", status: "connected", secretsEnc: null,
	disabledTools: [], tools: [{ name: "create_event", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }],
	updatedAt: new Date(),
};

describe("execução MCP confirmada", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getStrictMcpConnection).mockResolvedValue(record as never);
		vi.mocked(loadEffectiveAutonomy).mockResolvedValue({ policy: { level: "autonomous", exceptions: [] } } as never);
		vi.mocked(callMcpTool).mockResolvedValue({ ok: true, text: "feito", truncated: false });
	});

	it("busca conexão com dono exato e executa os argumentos confirmados", async () => {
		expect(await executeConfirmedMcpCall(call)).toMatchObject({ ok: true });
		expect(getStrictMcpConnection).toHaveBeenCalledWith("conn-a", "user-a");
		expect(callMcpTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "create_event", args: call.args }));
	});

	it("outro dono, tool alterada ou autonomia bloqueada não executam", async () => {
		vi.mocked(getStrictMcpConnection).mockResolvedValueOnce(null);
		expect((await executeConfirmedMcpCall(call)).ok).toBe(false);
		expect((await executeConfirmedMcpCall({ ...call, exposedName: "mcp__other__create_event" })).ok).toBe(false);
		vi.mocked(loadEffectiveAutonomy).mockResolvedValueOnce({ policy: { level: "autonomous", exceptions: [{ tool: call.exposedName, mode: "blocked" }] } } as never);
		expect((await executeConfirmedMcpCall(call)).ok).toBe(false);
		expect(callMcpTool).not.toHaveBeenCalled();
	});

	it("card antigo de webhook do GitHub via Composio não executa ao ser confirmado", async () => {
		const toolName = "GITHUB_CREATE_A_REPOSITORY_WEBHOOK";
		vi.mocked(getStrictMcpConnection).mockResolvedValueOnce({
			...record, slug: "composio", catalogId: "composio",
			tools: [{ ...record.tools[0], name: toolName }],
		} as never);
		const result = await executeConfirmedMcpCall({ ...call, toolName, exposedName: "mcp__composio__GITHUB_CREATE_A_REPOSITORY_WEBHOOK" });
		expect(result.ok).toBe(false);
		expect(result.text).toContain("gerenciados pelo sistema");
		expect(callMcpTool).not.toHaveBeenCalled();
	});
});

describe("escrita no GitHub: identidade", () => {
	const githubRecord = {
		...record,
		slug: "github",
		catalogId: "github",
		tools: [{ name: "issue_write", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }],
	};
	const issueCall = {
		...call,
		toolName: "issue_write",
		exposedName: "mcp__github__issue_write",
		args: { method: "create", owner: "exemplo", repo: "loja-monorepo", title: "Bug", body: "texto" },
	};
	const installed = {
		id: "row", userId: "user-a", installationId: "555", accountLogin: "exemplo", accountType: "User",
		repositorySelection: "selected", repositories: [{ fullName: "exemplo/site", private: true }], suspendedAt: null, createdAt: new Date(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(loadEffectiveAutonomy).mockResolvedValue({ policy: { level: "autonomous", exceptions: [] } } as never);
		vi.mocked(callMcpTool).mockResolvedValue({ ok: true, text: "feito", truncated: false });
		process.env.GITHUB_APP_ID = "1";
		process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
		process.env.GITHUB_APP_WEBHOOK_SECRET = "w";
		process.env.GITHUB_APP_SLUG = "meu-app";
		vi.mocked(getStrictMcpConnection).mockResolvedValue(githubRecord as never);
		vi.mocked(listGithubInstallationsForUser).mockResolvedValue([installed] as never);
		vi.mocked(getGithubWriteSettings).mockResolvedValue({ signature: false, signatureText: null });
	});

	it("repositório fora da instalação: NÃO escreve com a conta do usuário (nada passa pelo OAuth do conector)", async () => {
		const result = await executeConfirmedMcpCall(issueCall);
		expect(result.ok).toBe(false);
		expect(result.githubIdentity).toMatchObject({ reason: "not_installed", repo: "exemplo/loja-monorepo" });
		expect(callMcpTool).not.toHaveBeenCalled();
	});

	it("ação sem versão do app também não cai no conector: erro claro, nenhuma chamada MCP", async () => {
		vi.mocked(getStrictMcpConnection).mockResolvedValue({
			...githubRecord,
			tools: [{ name: "create_repository", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } }],
		} as never);
		const result = await executeConfirmedMcpCall({ ...issueCall, toolName: "create_repository", exposedName: "mcp__github__create_repository", args: { name: "x" } });
		expect(result.ok).toBe(false);
		expect(result.text).toContain("nunca é usada");
		expect(callMcpTool).not.toHaveBeenCalled();
	});

	it("'Pronto' refaz a chamada pelo app: ainda fora da instalação, continua bloqueado", async () => {
		await executeConfirmedMcpCall(issueCall);
		const again = await executeConfirmedMcpCall(issueCall);
		expect(again.githubIdentity).toBeDefined();
		expect(callMcpTool).not.toHaveBeenCalled();
	});
});
