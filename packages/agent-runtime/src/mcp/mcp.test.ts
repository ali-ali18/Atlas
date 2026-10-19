import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpToolInfo } from "@workspace/shared";
import { McpClientPool, defaultTransportFactory, type McpClientConfig } from "./client-pool.js";
import { MCP_AUTH_REQUIRED_MARKER } from "./auth-marker.js";
import { callMcpTool, capResultText, listMcpTools, normalizeCallToolResult } from "./call.js";
import { McpOAuthProvider, getFreshAccessToken, mcpOAuthRedirectUrl, resolveMcpOAuthClient } from "./oauth-provider.js";
import { buildMcpToolset, type McpToolsetConnection } from "./registry.js";
import { multiAccountLine } from "../computer-use.js";
import { redactSecrets, sanitizeErrorMessage } from "./sanitize.js";
import {
	SecretBoxError,
	isSecretBoxConfigured,
	openSecrets,
	sealSecrets,
	secretValues,
	type McpConnectorSecrets,
} from "./secret-box.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("secret-box", () => {
	const key = randomBytes(32);

	it("roundtrip com a mesma chave e nunca em claro", () => {
		const secrets = { apiKey: "fc-super-secreta-123", headers: { "X-Test": "abc" } };
		const sealed = sealSecrets(secrets, key);
		expect(sealed.startsWith("v1:")).toBe(true);
		expect(sealed).not.toContain("fc-super-secreta-123");
		expect(openSecrets(sealed, key)).toEqual(secrets);
		expect(openSecrets(null, key)).toEqual({});
	});

	it("chave errada ou formato inválido falha com SecretBoxError", () => {
		const sealed = sealSecrets({ apiKey: "x" }, key);
		expect(() => openSecrets(sealed, randomBytes(32))).toThrow(SecretBoxError);
		expect(() => openSecrets("lixo", key)).toThrow(SecretBoxError);
	});

	it("lê a chave do env (32 bytes base64) e recusa tamanho errado", () => {
		vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", key.toString("base64"));
		expect(isSecretBoxConfigured()).toBe(true);
		vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", randomBytes(16).toString("base64"));
		expect(isSecretBoxConfigured()).toBe(false);
		expect(() => sealSecrets({})).toThrow(SecretBoxError);
	});

	it("secretValues junta api key, headers e tokens", () => {
		expect(
			secretValues({
				apiKey: "chave-longa",
				headers: { Authorization: "Bearer abcdef" },
				oauth: { tokens: { access_token: "tok-acesso", refresh_token: "tok-refresh" } },
			}),
		).toEqual(["chave-longa", "Bearer abcdef", "tok-acesso", "tok-refresh"]);
	});
});

describe("oauth-provider", () => {
	it("resolveMcpOAuthClient lê client id/secret e authorizationParams do env; acusa o que falta", () => {
		vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "id-google");
		vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "segredo-google");
		const oauth = {
			clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
			clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
			authorizationParams: { access_type: "offline", prompt: "consent" },
		};
		expect(resolveMcpOAuthClient({ oauth })).toEqual({
			ready: true,
			client: {
				clientId: "id-google",
				clientSecret: "segredo-google",
				scope: undefined,
				authorizationParams: oauth.authorizationParams,
			},
		});

		vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
		vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
		expect(resolveMcpOAuthClient({ oauth })).toEqual({
			ready: false,
			missing: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
		});
	});

	it("mcpOAuthRedirectUrl deriva de ATLAS_URL (sem barra final), com fallback pro dev padrão", () => {
		vi.stubEnv("ATLAS_URL", "https://atlas.example.com");
		expect(mcpOAuthRedirectUrl()).toBe("https://atlas.example.com/v1/mcp/oauth/callback");

		vi.stubEnv("ATLAS_URL", "https://atlas.example.com/");
		expect(mcpOAuthRedirectUrl()).toBe("https://atlas.example.com/v1/mcp/oauth/callback");

		vi.stubEnv("ATLAS_URL", "");
		expect(mcpOAuthRedirectUrl()).toBe("http://localhost:3000/v1/mcp/oauth/callback");
	});

	it("clientMetadata inclui client_uri e logo_uri absolutos da origem pública", () => {
		const provider = new McpOAuthProvider(
			{},
			{
				redirectUrl: "https://atlas.example.com/v1/mcp/oauth/callback",
				client: {},
				persist: async () => {},
			},
		);
		expect(provider.clientMetadata).toMatchObject({
			client_name: "Atlas",
			client_uri: "https://atlas.example.com",
			logo_uri: "https://atlas.example.com/icons/logo-avatar.png",
			redirect_uris: ["https://atlas.example.com/v1/mcp/oauth/callback"],
		});
	});

	it("redirectToAuthorization adiciona os authorizationParams na URL de login", () => {
		const provider = new McpOAuthProvider(
			{},
			{
				redirectUrl: "http://localhost:3001/v1/mcp/oauth/callback",
				client: { authorizationParams: { access_type: "offline", prompt: "consent" } },
				persist: async () => {},
			},
		);
		provider.redirectToAuthorization(new URL("https://accounts.google.com/o/oauth2/v2/auth?client_id=abc"));
		expect(provider.authorizationUrl?.searchParams.get("access_type")).toBe("offline");
		expect(provider.authorizationUrl?.searchParams.get("prompt")).toBe("consent");
	});

	describe("getFreshAccessToken", () => {
		const client = { clientId: "cid", clientSecret: "csecret", authorizationServer: "https://accounts.google.com" };

		it("token sem expires_in (ou ainda dentro da margem) devolve sem renovar", async () => {
			const persist = vi.fn(async () => {});
			const semExpiry: McpConnectorSecrets = { oauth: { tokens: { access_token: "tok-1", token_type: "Bearer" } } };
			await expect(getFreshAccessToken({ secrets: semExpiry, client, persist })).resolves.toBe("tok-1");

			const fresco: McpConnectorSecrets = {
				oauth: { tokens: { access_token: "tok-2", token_type: "Bearer", expires_in: 3600 }, tokensSavedAt: Date.now() },
			};
			await expect(getFreshAccessToken({ secrets: fresco, client, persist })).resolves.toBe("tok-2");
			expect(persist).not.toHaveBeenCalled();
		});

		it("sem token salvo joga UnauthorizedError", async () => {
			await expect(getFreshAccessToken({ secrets: {}, client, persist: async () => {} })).rejects.toBeInstanceOf(UnauthorizedError);
		});

		it("token expirado sem refresh_token joga UnauthorizedError", async () => {
			const secrets: McpConnectorSecrets = {
				oauth: { tokens: { access_token: "tok-velho", token_type: "Bearer", expires_in: 3600 }, tokensSavedAt: Date.now() - 2 * 3600_000 },
			};
			await expect(getFreshAccessToken({ secrets, client, persist: async () => {} })).rejects.toBeInstanceOf(UnauthorizedError);
		});

		it("token expirado com refresh_token renova via refreshAuthorization e preserva o refresh_token se a resposta omitir", async () => {
			const secrets: McpConnectorSecrets = {
				oauth: {
					tokens: { access_token: "tok-velho", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 },
					tokensSavedAt: Date.now() - 2 * 3600_000,
				},
			};
			const persist = vi.fn(async () => {});
			const tokenCalls: URLSearchParams[] = [];
			const fetchFn = async (input: string | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/.well-known/")) {
					return new Response(
						JSON.stringify({
							issuer: "https://accounts.google.com",
							authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
							token_endpoint: "https://oauth2.googleapis.com/token",
							response_types_supported: ["code"],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (url.includes("/token")) {
					tokenCalls.push(new URLSearchParams(String(init?.body ?? "")));
					return new Response(
						JSON.stringify({ access_token: "tok-novo", token_type: "Bearer", expires_in: 3600 }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			};
			const token = await getFreshAccessToken({ secrets, client, persist, fetchFn });
			expect(token).toBe("tok-novo");
			expect(tokenCalls[0]?.get("grant_type")).toBe("refresh_token");
			expect(tokenCalls[0]?.get("refresh_token")).toBe("refresh-1");
			expect(persist).toHaveBeenCalledOnce();
			const saved = persist.mock.calls[0]?.[0] as McpConnectorSecrets;
			expect(saved.oauth?.tokens).toMatchObject({ access_token: "tok-novo", refresh_token: "refresh-1" });
			expect(typeof saved.oauth?.tokensSavedAt).toBe("number");
		});

		it("refresh recusado pelo Google joga UnauthorizedError (não deriva)", async () => {
			const secrets: McpConnectorSecrets = {
				oauth: {
					tokens: { access_token: "tok-velho", refresh_token: "refresh-revogado", token_type: "Bearer", expires_in: 3600 },
					tokensSavedAt: Date.now() - 2 * 3600_000,
				},
			};
			const fetchFn = async (input: string | URL) => {
				const url = String(input);
				if (url.includes("/.well-known/")) {
					return new Response(
						JSON.stringify({
							issuer: "https://accounts.google.com",
							authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
							token_endpoint: "https://oauth2.googleapis.com/token",
							response_types_supported: ["code"],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (url.includes("/token")) {
					return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
				}
				return new Response("not found", { status: 404 });
			};
			await expect(
				getFreshAccessToken({ secrets, client, persist: async () => {}, fetchFn }),
			).rejects.toThrow(MCP_AUTH_REQUIRED_MARKER);
		});
	});
});

describe("sanitize", () => {
	it("redige segredos conhecidos e padrões de token", () => {
		const text = "falhou com key=minha-chave e Authorization: Bearer abcdefghijklmnop ghp_123456789012345678901234";
		const out = redactSecrets(text, ["minha-chave"]);
		expect(out).not.toContain("minha-chave");
		expect(out).not.toContain("abcdefghijklmnop");
		expect(out).not.toContain("ghp_");
		expect(sanitizeErrorMessage(new Error("x".repeat(900))).length).toBe(500);
	});
});

const readTool: McpToolInfo = {
	name: "search",
	description: "Busca páginas",
	inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
	annotations: { readOnlyHint: true },
};
const writeTool: McpToolInfo = {
	name: "create-page",
	description: "Cria página",
	inputSchema: { type: "object", properties: { title: { type: "string" } } },
};

function connection(overrides: Partial<McpToolsetConnection> = {}): McpToolsetConnection {
	return {
		id: "c1",
		slug: "notion",
		name: "Notion",
		tools: [readTool, writeTool],
		disabledTools: [],
		confirmWrites: true,
		...overrides,
	};
}

describe("buildMcpToolset", () => {
	it("catálogo pequeno: expõe mcp__<slug>__<tool> desde o passo 1, não deferred", () => {
		const set = buildMcpToolset([connection()]);
		expect(set.deferred).toBe(false);
		expect(set.tools.map((tool) => tool.function.name)).toEqual([
			"mcp__notion__search",
			"mcp__notion__create-page",
		]);
		expect(set.tools[0]?.function.description).toBe("[Notion] Busca páginas");
		expect(set.tools[0]?.function.parameters.required).toEqual(["query"]);
		expect(set.entries.get("mcp__notion__search")).toMatchObject({
			connectionId: "c1",
			toolName: "search",
			readOnly: true,
			requiresConfirmation: false,
		});
		expect(set.entries.get("mcp__notion__create-page")?.requiresConfirmation).toBe(true);
		expect(set.connectorNames).toEqual(["Notion"]);
		expect(set.omitted).toEqual([]);
		// Catálogo (available/entries/index) sempre cobre tudo, deferred ou não.
		expect(set.available.size).toBe(2);
		expect([...set.available.keys()]).toEqual(["mcp__notion__search", "mcp__notion__create-page"]);
		expect(set.index).toEqual([
			{
				connectorName: "Notion",
				slug: "notion",
				tools: [
					{ name: "mcp__notion__search", toolName: "search", summary: "Busca páginas", readOnly: true },
					{
						name: "mcp__notion__create-page",
						toolName: "create-page",
						summary: "Cria página",
						readOnly: false,
					},
				],
			},
		]);
	});

	it("várias contas do mesmo serviço: nomes incluem a conta, tools têm prefixos distintos e o prompt manda perguntar", () => {
		const set = buildMcpToolset([
			connection({ id: "c1", slug: "notion", accountLabel: "Notion pessoal" }),
			connection({ id: "c2", slug: "notion-2", accountLabel: null }),
		]);
		expect(set.connectorNames).toEqual(["Notion — Notion pessoal", "Notion — notion-2"]);
		expect(set.available.has("mcp__notion__search")).toBe(true);
		expect(set.available.has("mcp__notion-2__search")).toBe(true);
		expect(set.tools.find((t) => t.function.name === "mcp__notion__search")?.function.description).toBe("[Notion — Notion pessoal] Busca páginas");
		expect(set.entries.get("mcp__notion-2__search")).toMatchObject({ connectionId: "c2", connectionName: "Notion — notion-2" });
		expect(set.multiAccountServices).toEqual(["Notion"]);
		expect(multiAccountLine(set).join(" ")).toMatch(/mais de uma conta de: Notion.*pergunte ao usuário/);
	});

	it("uma conta só: sem apelido nada muda; com apelido o nome o inclui; sem linha de várias contas", () => {
		const plain = buildMcpToolset([connection()]);
		expect(plain.connectorNames).toEqual(["Notion"]);
		expect(plain.multiAccountServices).toBeUndefined();
		expect(multiAccountLine(plain)).toEqual([]);
		expect(buildMcpToolset([connection({ accountLabel: "Notion pessoal" })]).connectorNames).toEqual(["Notion — Notion pessoal"]);
	});

	it("respeita disabledTools; confirmWrites é ignorado (a autonomia decide)", () => {
		expect(
			buildMcpToolset([connection({ disabledTools: ["search"] })]).tools,
		).toHaveLength(1);
		expect(
			buildMcpToolset([connection({ confirmWrites: false })]).entries.get(
				"mcp__notion__create-page",
			)?.requiresConfirmation,
		).toBe(true);
	});

	describe("autonomia (F10)", () => {
		const names = (set: ReturnType<typeof buildMcpToolset>) => set.tools.map((tool) => tool.function.name);
		const level = (l: "autonomous" | "balanced" | "always_ask", exceptions: Array<{ connector?: string; tool?: string; mode: "always_ask" | "never_ask" | "blocked" }> = []) => ({
			level: l,
			exceptions,
		});

		it("Autônomo: escrita executa sem confirmação; Equilibrado e Sempre perguntar pedem", () => {
			expect(buildMcpToolset([connection()], { autonomy: level("autonomous") }).entries.get("mcp__notion__create-page")?.requiresConfirmation).toBe(false);
			expect(buildMcpToolset([connection()], { autonomy: level("balanced") }).entries.get("mcp__notion__create-page")?.requiresConfirmation).toBe(true);
			expect(buildMcpToolset([connection()], { autonomy: level("always_ask") }).entries.get("mcp__notion__create-page")?.requiresConfirmation).toBe(true);
		});

		it("blocked (por tool ou conector) tira a tool do catálogo", () => {
			const byTool = buildMcpToolset([connection()], { autonomy: level("autonomous", [{ tool: "mcp__notion__create-page", mode: "blocked" }]) });
			expect(names(byTool)).toEqual(["mcp__notion__search"]);
			expect(byTool.available.has("mcp__notion__create-page")).toBe(false);
			const byConnector = buildMcpToolset([connection()], { autonomy: level("balanced", [{ connector: "notion", mode: "blocked" }]) });
			expect(byConnector.tools).toEqual([]);
		});

		it("rotina (unattended) recebe só o que é allow: leitura sempre, escrita só no Autônomo", () => {
			expect(names(buildMcpToolset([connection()], { unattended: true }))).toEqual(["mcp__notion__search"]);
			expect(names(buildMcpToolset([connection()], { unattended: true, autonomy: level("autonomous") }))).toEqual([
				"mcp__notion__search",
				"mcp__notion__create-page",
			]);
			expect(
				names(
					buildMcpToolset([connection()], {
						unattended: true,
						autonomy: level("balanced", [{ tool: "mcp__notion__create-page", mode: "never_ask" }]),
					}),
				),
			).toEqual(["mcp__notion__search", "mcp__notion__create-page"]);
		});

		it("apagar/enviar pergunta em qualquer nível e nunca entra em rotina Autônoma", () => {
			const dangerous = { name: "delete-page", description: "Apaga", inputSchema: { type: "object", properties: {} } };
			const conn = connection({ tools: [readTool, writeTool, dangerous] });
			const set = buildMcpToolset([conn], { autonomy: level("autonomous") });
			expect(set.entries.get("mcp__notion__delete-page")).toMatchObject({ actionClass: "irreversible", requiresConfirmation: true });
			expect(names(buildMcpToolset([conn], { autonomy: level("autonomous"), unattended: true }))).not.toContain("mcp__notion__delete-page");
		});
	});

	it("catálogo que não cabe no orçamento ativo fica deferred: tools vazio, catálogo completo em available/entries/index", () => {
		const many = Array.from({ length: 5 }, (_, i) => ({ ...readTool, name: `t${i}` }));
		const set = buildMcpToolset([connection({ tools: many })], { maxTools: 3 });
		expect(set.deferred).toBe(true);
		expect(set.tools).toEqual([]);
		expect(set.available.size).toBe(5);
		expect(set.entries.size).toBe(5);
		expect(set.omitted).toEqual([
			"mcp__notion__t0",
			"mcp__notion__t1",
			"mcp__notion__t2",
			"mcp__notion__t3",
			"mcp__notion__t4",
		]);
		expect(set.connectorNames).toEqual(["Notion"]);
		expect(set.index).toHaveLength(1);
		expect(set.index[0]?.tools).toHaveLength(5);
	});

	it("catálogo grande (3 conectores x 20 tools) fica deferred; índice cobre todos os conectores", () => {
		const longDescription = "x".repeat(2000);
		function bigConnection(id: string, slug: string, name: string) {
			return connection({
				id,
				slug,
				name,
				tools: Array.from({ length: 20 }, (_, i) => ({
					name: `tool_${i}`,
					description: `${longDescription} ${i}`,
					inputSchema: { type: "object", properties: { q: { type: "string" } } },
					annotations: { readOnlyHint: true },
				})),
			});
		}
		const set = buildMcpToolset([
			bigConnection("c1", "firecrawl", "Firecrawl"),
			bigConnection("c2", "github", "GitHub"),
			bigConnection("c3", "notion", "Notion"),
		]);
		expect(set.deferred).toBe(true);
		expect(set.tools).toEqual([]);
		expect(set.available.size).toBe(60);
		expect(set.entries.size).toBe(60);
		expect(set.omitted).toHaveLength(60);
		expect(set.connectorNames).toEqual(["Firecrawl", "GitHub", "Notion"]);
		expect(set.index).toHaveLength(3);
		expect(set.index.every((connector) => connector.tools.length === 20)).toBe(true);
	});

	it("schema sem properties vira objeto válido", () => {
		const set = buildMcpToolset([
			connection({ tools: [{ name: "ping", inputSchema: {} }] }),
		]);
		expect(set.tools[0]?.function.parameters).toEqual({ type: "object", properties: {} });
	});
});

describe("normalizeCallToolResult / capResultText", () => {
	it("junta partes de texto e descreve binários", () => {
		expect(
			normalizeCallToolResult({
				content: [
					{ type: "text", text: "a" },
					{ type: "image", data: "xxx", mimeType: "image/png" },
					{ type: "resource", resource: { uri: "file://x", text: "b" } },
				],
			}),
		).toEqual({ ok: true, text: "a\n\n[imagem omitida]\n\nb", images: [{ data: "xxx", mimeType: "image/png" }] });
		expect(normalizeCallToolResult({ content: [], structuredContent: { n: 1 } }).text).toBe('{"n":1}');
		expect(normalizeCallToolResult({ isError: true, content: [] }).ok).toBe(false);
	});

	it("trunca com aviso acionável ao modelo", () => {
		const capped = capResultText("z".repeat(50), 10);
		expect(capped.truncated).toBe(true);
		expect(capped.text).toBe(`${"z".repeat(10)}\n[Result truncated: showing ~10 of 50 characters. Do not conclude about items not shown — narrow the query (filters, search term) or fetch further pages before answering. Never give totals, rankings or conclusions until you have read all of it.]`);
	});
});

function fakeServer(): Server {
	const server = new Server(
		{ name: "fake", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{ ...readTool, annotations: { readOnlyHint: true } },
			{ name: writeTool.name, description: writeTool.description, inputSchema: { type: "object" as const } },
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		if (request.params.name === "search") {
			const query = String(request.params.arguments?.query ?? "");
			return { content: [{ type: "text" as const, text: `resultado: ${query} token=segredo-do-servidor` }] };
		}
		return { isError: true, content: [{ type: "text" as const, text: "tool desconhecida" }] };
	});
	return server;
}

function inMemoryPool(): { pool: McpClientPool; connects: () => number } {
	let count = 0;
	const pool = new McpClientPool(() => {
		count += 1;
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		void fakeServer().connect(serverTransport);
		return clientTransport;
	});
	return { pool, connects: () => count };
}

const config: McpClientConfig = { id: "c1", version: "v1", name: "Fake", url: "http://fake.local/mcp" };

describe("McpClientPool + callMcpTool (servidor em memória)", () => {
	it("lista tools com anotações e chama com redação de segredo", async () => {
		const { pool, connects } = inMemoryPool();
		const tools = await pool.withClient(config, (client) => listMcpTools(client));
		expect(tools.map((tool) => tool.name)).toEqual(["search", "create-page"]);
		expect(tools[0]?.annotations?.readOnlyHint).toBe(true);

		const result = await callMcpTool({
			pool,
			config,
			toolName: "search",
			args: { query: "macbook" },
			secrets: ["segredo-do-servidor"],
		});
		expect(result).toEqual({
			ok: true,
			text: "resultado: macbook token=[redacted]",
			truncated: false,
		});
		expect(connects()).toBe(1);

		const failed = await callMcpTool({ pool, config, toolName: "nope", args: {} });
		expect(failed.ok).toBe(false);
		expect(failed.text).toBe("tool desconhecida");
		await pool.closeAll();
	});

	it("reusa o cliente na mesma versão e reconecta quando a versão muda", async () => {
		const { pool, connects } = inMemoryPool();
		await pool.get(config);
		await pool.get(config);
		expect(connects()).toBe(1);
		await pool.get({ ...config, version: "v2" });
		expect(connects()).toBe(2);
		await pool.closeAll();
	});

	it("withClient reconecta 1x em falha de transporte", async () => {
		const { pool, connects } = inMemoryPool();
		let attempts = 0;
		const value = await pool.withClient(config, async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("socket fechado");
			return "ok";
		});
		expect(value).toBe("ok");
		expect(connects()).toBe(2);
		await pool.closeAll();
	});
});

describe("McpClientPool + builtin://google (defaultTransportFactory)", () => {
	it.each([
		["sem login", {}],
		["token expirado sem refresh", {
			oauth: { tokens: { access_token: "expired", token_type: "Bearer", expires_in: 3600 }, tokensSavedAt: Date.now() - 2 * 3600_000 },
		}],
	])("%s atravessa o MCP e pede reconexão", async (_case, secrets) => {
		const pool = new McpClientPool(defaultTransportFactory);
		const builtinConfig: McpClientConfig = {
			id: "google-calendar-auth",
			version: "v1",
			name: "Google Agenda",
			url: "builtin://google/calendar",
			builtin: {
				getAccessToken: () => getFreshAccessToken({
					secrets: secrets as McpConnectorSecrets,
					client: { clientId: "cid", clientSecret: "secret", authorizationServer: "https://accounts.google.com" },
					persist: async () => {},
				}),
			},
		};
		try {
			await expect(pool.withClient(builtinConfig, (client) => client.callTool({ name: "list_calendars", arguments: {} })))
				.rejects.toThrow(MCP_AUTH_REQUIRED_MARKER);
			const result = await callMcpTool({ pool, config: builtinConfig, toolName: "list_calendars", args: {} });
			expect(result).toMatchObject({ ok: false, authFailed: true });
			expect(result.text).toContain("call propose_connector");
		} finally {
			await pool.closeAll();
		}
	});

	it("conecta em builtin://google/calendar e lista as tools do servidor embutido", async () => {
		const pool = new McpClientPool(defaultTransportFactory);
		const builtinConfig: McpClientConfig = {
			id: "google-calendar",
			version: "v1",
			name: "Google Agenda",
			url: "builtin://google/calendar",
			builtin: { getAccessToken: async () => "tok-embutido" },
		};
		const tools = await pool.withClient(builtinConfig, (client) => listMcpTools(client));
		expect(tools.map((tool) => tool.name)).toEqual(["list_calendars", "list_events", "get_event", "create_event"]);
		await pool.closeAll();
	});

	it("403 de permissão de arquivo num builtin volta ok:false SEM authFailed (conexão não vira pending_auth)", async () => {
		const pool = new McpClientPool(defaultTransportFactory);
		vi.stubGlobal("fetch", async () => ({
			ok: false,
			status: 403,
			json: async () => ({ error: { message: "The caller does not have permission" } }),
			text: async () => "",
		}));
		const builtinConfig: McpClientConfig = {
			id: "google-sheets-403",
			version: "v1",
			name: "Google Planilhas",
			url: "builtin://google/sheets",
			builtin: { getAccessToken: async () => "tok-embutido" },
		};
		try {
			const result = await callMcpTool({
				pool,
				config: builtinConfig,
				toolName: "read_range",
				args: { spreadsheetId: "1wfGr7", range: "A1" },
			});
			expect(result.ok).toBe(false);
			expect(result.authFailed).toBeUndefined();
			expect(result.text).toContain("create_spreadsheet");
		} finally {
			await pool.closeAll();
		}
	});

	it("sem builtin.getAccessToken, a conexão falha (sem transporte HTTP real pra builtin://)", async () => {
		const pool = new McpClientPool(defaultTransportFactory);
		const badConfig: McpClientConfig = {
			id: "google-calendar-sem-token",
			version: "v1",
			name: "Google Agenda",
			url: "builtin://google/calendar",
		};
		await expect(pool.get(badConfig)).rejects.toThrow();
		await pool.closeAll();
	});
});

describe("buildMcpToolset descrição e schema longos", () => {
	it("mantém a descrição até 4000 chars (instruções de uso) e o schema inteiro", () => {
		const description = `${"Chame get_workflow_sdk_reference antes. ".repeat(60)}FIM`;
		const properties = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`campo_${i}`, { type: "string", description: "d".repeat(80) }]));
		const set = buildMcpToolset([
			connection({ tools: [{ name: "create_workflow_from_code", description, inputSchema: { type: "object", properties } }] }),
		]);
		const fn = set.tools[0]!.function;
		expect(description.length).toBeGreaterThan(1_000);
		expect(fn.description.endsWith("FIM")).toBe(true);
		expect(Object.keys(fn.parameters.properties as object)).toHaveLength(80);
	});
});
