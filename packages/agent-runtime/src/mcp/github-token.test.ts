import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConnectionRecord } from "@workspace/db";
import { getGithubConnectionToken, markGithubConnectionAuthFailed } from "./github-token.js";
import { sealSecrets, type McpConnectorSecrets } from "./secret-box.js";

/**
 * `getMcpConnectionByCatalogId`/`updateMcpConnection` são as únicas pontes
 * com o banco: mockadas aqui como em `computer-use.test.ts`.
 */
const getMcpConnectionByCatalogId = vi.fn<
	(catalogId: string, userId?: string) => Promise<McpConnectionRecord | null>
>();
const updateMcpConnection = vi.fn<
	(id: string, patch: Record<string, unknown>) => Promise<McpConnectionRecord | null>
>(async () => null);

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getMcpConnectionByCatalogId: (...args: [string, string?]) => getMcpConnectionByCatalogId(...args),
		updateMcpConnection: (...args: [string, Record<string, unknown>]) => updateMcpConnection(...args),
	};
});

const ENCRYPTION_KEY = randomBytes(32);

function baseRecord(overrides: Partial<McpConnectionRecord> = {}): McpConnectionRecord {
	return {
		id: "conn-github-1",
		catalogId: "github",
		slug: "github",
		name: "GitHub",
		url: "https://api.githubcopilot.com/mcp/",
		authType: "api_key",
		status: "connected",
		tools: [],
		disabledTools: [],
		confirmWrites: true,
		lastError: null,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		secretsEnc: null,
		oauthStateHash: null,
		...overrides,
	};
}

function seal(secrets: McpConnectorSecrets): string {
	return sealSecrets(secrets, ENCRYPTION_KEY);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
	vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", ENCRYPTION_KEY.toString("base64"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	getMcpConnectionByCatalogId.mockReset();
	updateMcpConnection.mockReset();
	updateMcpConnection.mockResolvedValue(null);
});

describe("getGithubConnectionToken", () => {
	it("PAT: devolve secrets.apiKey e o login (fetch cheap)", async () => {
		getMcpConnectionByCatalogId.mockResolvedValue(
			baseRecord({ authType: "api_key", secretsEnc: seal({ apiKey: "ghp_pat_123" }) }),
		);
		const fetchFn = vi.fn(async (input: string | URL) => {
			expect(String(input)).toBe("https://api.github.com/user");
			return jsonResponse({ login: "ali-ali18" });
		});
		const result = await getGithubConnectionToken("default", { fetchFn, withLogin: true });
		expect(result).toEqual({ token: "ghp_pat_123", login: "ali-ali18", source: "pat" });
		expect(getMcpConnectionByCatalogId).toHaveBeenCalledWith("github", "default");
	});

	it("sem withLogin (default): não chama GET /user, login fica undefined", async () => {
		getMcpConnectionByCatalogId.mockResolvedValue(
			baseRecord({ authType: "api_key", secretsEnc: seal({ apiKey: "ghp_pat_123" }) }),
		);
		const fetchFn = vi.fn(async () => jsonResponse({ login: "não devia ser chamado" }));
		const result = await getGithubConnectionToken("default", { fetchFn });
		expect(result).toEqual({ token: "ghp_pat_123", login: undefined, source: "pat" });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("OAuth: token sem expires_in (não expira) é usado direto", async () => {
		getMcpConnectionByCatalogId.mockResolvedValue(
			baseRecord({
				authType: "oauth",
				secretsEnc: seal({ oauth: { tokens: { access_token: "tok-oauth", token_type: "Bearer" } } }),
			}),
		);
		const fetchFn = vi.fn(async () => jsonResponse({ login: "octocat" }));
		const result = await getGithubConnectionToken("default", { fetchFn, withLogin: true });
		expect(result).toEqual({ token: "tok-oauth", login: "octocat", source: "oauth" });
	});

	it("OAuth: token expirado com refresh_token renova via refreshAuthorization e persiste", async () => {
		vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "cid");
		vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "csecret");
		const record = baseRecord({
			authType: "oauth",
			secretsEnc: seal({
				oauth: {
					tokens: { access_token: "tok-velho", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 },
					tokensSavedAt: Date.now() - 2 * 3600_000,
				},
			}),
		});
		getMcpConnectionByCatalogId.mockResolvedValue(record);
		const tokenCalls: URLSearchParams[] = [];
		const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/.well-known/")) {
				return jsonResponse({
					issuer: "https://github.com/login/oauth",
					authorization_endpoint: "https://github.com/login/oauth/authorize",
					token_endpoint: "https://github.com/login/oauth/access_token",
					response_types_supported: ["code"],
				});
			}
			if (url.includes("access_token") || url.includes("/token")) {
				tokenCalls.push(new URLSearchParams(String(init?.body ?? "")));
				return jsonResponse({ access_token: "tok-novo", token_type: "Bearer" });
			}
			if (url === "https://api.github.com/user") return jsonResponse({ login: "octocat" });
			return new Response("not found", { status: 404 });
		});
		const result = await getGithubConnectionToken("default", { fetchFn, withLogin: true });
		expect(result).toEqual({ token: "tok-novo", login: "octocat", source: "oauth" });
		expect(tokenCalls[0]?.get("grant_type")).toBe("refresh_token");
		expect(tokenCalls[0]?.get("refresh_token")).toBe("refresh-1");
		expect(updateMcpConnection).toHaveBeenCalledOnce();
		const [id, patch] = updateMcpConnection.mock.calls[0] as [string, { secretsEnc: string }];
		expect(id).toBe(record.id);
		expect(typeof patch.secretsEnc).toBe("string");
	});

	it("sem conexão: erro pedindo pra conectar no Marketplace", async () => {
		getMcpConnectionByCatalogId.mockResolvedValue(null);
		const result = await getGithubConnectionToken("default");
		expect(result).toEqual({ error: "Conecte o GitHub no Marketplace ou pelo Composio" });
	});

	it("conexão existe mas não está 'connected': mesmo erro", async () => {
		getMcpConnectionByCatalogId.mockResolvedValue(baseRecord({ status: "pending_auth" }));
		const result = await getGithubConnectionToken("default");
		expect(result).toEqual({ error: "Conecte o GitHub no Marketplace ou pelo Composio" });
	});

	it("OAuth: refresh recusado (401-like) marca a conexão como pending_auth", async () => {
		vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "cid");
		vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "csecret");
		const record = baseRecord({
			authType: "oauth",
			secretsEnc: seal({
				oauth: {
					tokens: { access_token: "tok-velho", refresh_token: "refresh-revogado", token_type: "Bearer", expires_in: 3600 },
					tokensSavedAt: Date.now() - 2 * 3600_000,
				},
			}),
		});
		getMcpConnectionByCatalogId.mockResolvedValue(record);
		const fetchFn = vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url.includes("/.well-known/")) {
				return jsonResponse({
					issuer: "https://github.com/login/oauth",
					authorization_endpoint: "https://github.com/login/oauth/authorize",
					token_endpoint: "https://github.com/login/oauth/access_token",
					response_types_supported: ["code"],
				});
			}
			return jsonResponse({ error: "bad_refresh_token" }, 400);
		});
		const result = await getGithubConnectionToken("default", { fetchFn });
		expect(result).toEqual({ error: "Reconecte o GitHub no Marketplace" });
		expect(updateMcpConnection).toHaveBeenCalledWith(record.id, {
			status: "pending_auth",
			lastError: "Reconecte o GitHub no Marketplace",
		});
	});
});

describe("markGithubConnectionAuthFailed", () => {
	it("401 da API do GitHub: marca a conexão pending_auth com a mensagem de reconexão", async () => {
		const record = baseRecord();
		getMcpConnectionByCatalogId.mockResolvedValue(record);
		await markGithubConnectionAuthFailed("default");
		expect(updateMcpConnection).toHaveBeenCalledWith(record.id, {
			status: "pending_auth",
			lastError: "Reconecte o GitHub no Marketplace",
		});
	});

	it("sem conexão: não chama updateMcpConnection", async () => {
		getMcpConnectionByCatalogId.mockResolvedValue(null);
		await markGithubConnectionAuthFailed("default");
		expect(updateMcpConnection).not.toHaveBeenCalled();
	});
});
