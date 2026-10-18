import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { buildMcpToolset } from "../registry.js";
import {
	ComposioApiError,
	composioMcpUrl,
	composioServerIdFromUrl,
	composioUserId,
	createComposioClient,
} from "./client.js";
import { withoutNativeDuplicates } from "./records.js";
import { formatComposioError, isComposioNoAuthError } from "./client.js";

const API_KEY = "cmp_live_super_secret_key_123";
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function clientWith(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
	const calls: { url: URL; init: RequestInit }[] = [];
	const fetchFn = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		calls.push({ url, init: init ?? {} });
		return handler(url, init ?? {});
	}) as unknown as typeof fetch;
	return { client: createComposioClient({ apiKey: API_KEY, fetchFn }), calls };
}

describe("cliente do Composio (fetch mockado)", () => {
	it("lista toolkits com x-api-key e normaliza a resposta", async () => {
		const { client, calls } = clientWith(() =>
			json({
				items: [
					{ slug: "github", name: "GitHub", meta: { description: "Código", logo: "https://x/logo.png" } },
					{ name: "sem slug" },
				],
				next_cursor: "abc",
			}),
		);
		const page = await client.listToolkits({ search: "git", limit: 10 });
		expect(page).toEqual({
			items: [{ slug: "github", name: "GitHub", description: "Código", logo: "https://x/logo.png", noAuth: false }],
			nextCursor: "abc",
			totalItems: null,
		});
		expect(calls[0]?.url.pathname).toBe("/api/v3.1/toolkits");
		expect(calls[0]?.url.searchParams.get("search")).toBe("git");
		expect((calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBe(API_KEY);
	});

	it("pagina a lista: repassa cursor, categoria e ordenação e devolve total", async () => {
		const { client, calls } = clientWith(() =>
			json({ items: [{ slug: "composio", name: "Composio" }, { slug: "gmail", name: "Gmail" }], next_cursor: "c2", total_items: 321 }),
		);
		const page = await client.listToolkits({ limit: 24, cursor: "c1", category: "productivity", sortBy: "usage" });
		const params = calls[0]?.url.searchParams;
		expect(params?.get("limit")).toBe("24");
		expect(params?.get("cursor")).toBe("c1");
		expect(params?.get("category")).toBe("productivity");
		expect(params?.get("sort_by")).toBe("usage");
		expect(page.items.map((item) => item.slug)).toEqual(["gmail"]);
		expect(page.nextCursor).toBe("c2");
		expect(page.totalItems).toBe(321);
	});

	it("lista categorias e ignora linhas sem id", async () => {
		const { client, calls } = clientWith(() =>
			json({ items: [{ id: "developer-tools", name: "Developer Tools" }, { name: "sem id" }, { id: "crm" }] }),
		);
		expect(await client.listToolkitCategories()).toEqual([
			{ id: "developer-tools", name: "Developer Tools" },
			{ id: "crm", name: "crm" },
		]);
		expect(calls[0]?.url.pathname).toBe("/api/v3.1/toolkits/categories");
	});

	it("cria o servidor MCP com os toolkits e auth configs", async () => {
		const { client, calls } = clientWith(() => json({ id: "srv_1", name: "x" }));
		const id = await client.createMcpServer({ name: "atlas-1", toolkits: [{ slug: "gmail", authConfigId: "ac_1" }] });
		expect(id).toBe("srv_1");
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.url.pathname).toBe("/api/v3.1/mcp/servers");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			name: "atlas-1",
			auth_config_ids: ["ac_1"],
			managed_auth_via_composio: true,
		});
	});

	it("reaproveita o auth config existente e cria um gerenciado quando não há", async () => {
		const existing = clientWith(() => json({ items: [{ id: "ac_old" }] }));
		expect(await existing.client.ensureAuthConfig("gmail")).toBe("ac_old");
		expect(existing.calls).toHaveLength(1);

		const created = clientWith((_url, init) => (init.method === "GET" ? json({ items: [] }) : json({ auth_config: { id: "ac_new" } })));
		expect(await created.client.ensureAuthConfig("gmail")).toBe("ac_new");
		expect(JSON.parse(String(created.calls[1]?.init.body)).auth_config.type).toBe("use_composio_managed_auth");
	});

	it("gera o link de conexão com callback e user_id", async () => {
		const { client, calls } = clientWith(() => json({ redirect_url: "https://connect.composio.dev/link/ln_1", connected_account_id: "ca_1" }, 201));
		const link = await client.createConnectLink({ authConfigId: "ac_1", composioUser: "atlas_u", callbackUrl: "https://atlas/v1/composio/callback?state=s" });
		expect(link).toEqual({ redirectUrl: "https://connect.composio.dev/link/ln_1", connectedAccountId: "ca_1" });
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			auth_config_id: "ac_1",
			user_id: "atlas_u",
			callback_url: "https://atlas/v1/composio/callback?state=s",
		});
	});

	it("lista contas conectadas filtrando pelo user_id", async () => {
		const { client, calls } = clientWith(() => json({ items: [{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "GitHub" } }, { id: "ca_2" }] }));
		expect(await client.listConnectedAccounts("atlas_u")).toEqual([{ id: "ca_1", toolkit: "github", status: "ACTIVE" }]);
		expect(calls[0]?.url.searchParams.get("user_ids")).toBe("atlas_u");
	});

	it("401 vira erro amigável sem ecoar a chave", async () => {
		const { client } = clientWith(() => json({ error: `bad key ${API_KEY}` }, 401));
		const error = await client.listToolkits().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ComposioApiError);
		expect((error as ComposioApiError).message).toBe("chave do Composio recusada");
	});

	it("erro 500 e erro de rede têm a chave redigida", async () => {
		const server = clientWith(() => new Response(`boom ${API_KEY}`, { status: 500 }));
		const e1 = (await server.client.listToolkits().catch((e: unknown) => e)) as Error;
		expect(e1.message).toContain("500");
		expect(e1.message).not.toContain(API_KEY);

		const network = clientWith(() => {
			throw new Error(`connect ECONNREFUSED ${API_KEY}`);
		});
		const e2 = (await network.client.listToolkits().catch((e: unknown) => e)) as Error;
		expect(e2.message).not.toContain(API_KEY);
	});
});

describe("apps sem login e meta-toolkit", () => {
	it("lê no_auth da lista e esconde o toolkit meta composio", async () => {
		const { client } = clientWith(() =>
			json({
				items: [
					{ slug: "composio", name: "Composio", no_auth: true },
					{ slug: "exa", name: "Exa", no_auth: true },
					{ slug: "github", name: "GitHub", no_auth: false },
					{ slug: "gmail", name: "Gmail" },
				],
			}),
		);
		const page = await client.listToolkits();
		expect(page.items.map((item) => [item.slug, item.noAuth])).toEqual([
			["exa", true],
			["github", false],
			["gmail", false],
		]);
	});

	it("página só com o meta-toolkit vira lista vazia (não é formato inválido)", async () => {
		const { client } = clientWith(() => json({ items: [{ slug: "composio", name: "Composio" }] }));
		expect((await client.listToolkits()).items).toEqual([]);
	});

	it("findToolkit acha pelo slug exato", async () => {
		const { client } = clientWith(() => json({ items: [{ slug: "exa_search", name: "Exa Search" }, { slug: "exa", name: "Exa", no_auth: true }] }));
		expect((await client.findToolkit("exa"))?.noAuth).toBe(true);
		expect(await client.findToolkit("outro")).toBeNull();
	});

	it("createMcpServer manda no_auth_apps e aceita auth_config_ids vazio", async () => {
		const { client, calls } = clientWith(() => json({ id: "srv_1" }));
		await client.createMcpServer({ name: "atlas-1", toolkits: [], noAuthApps: ["exa", "exa"] });
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			name: "atlas-1",
			auth_config_ids: [],
			no_auth_apps: ["exa"],
			managed_auth_via_composio: true,
		});
	});

	it("400 Auth_Config_NoAuthApp (303) é reconhecido e a mensagem não despeja o JSON", async () => {
		const raw = {
			error: {
				message: "Cannot create an auth config for toolkit \"composio\" because it does not require authentication.",
				code: 303,
				slug: "Auth_Config_NoAuthApp",
				status: 400,
				suggested_fix: "Toolkit works without an auth config.",
			},
		};
		const { client } = clientWith(() => json(raw, 400));
		const error = (await client.createMcpServer({ name: "atlas-1", toolkits: [] }).catch((e: unknown) => e)) as ComposioApiError;
		expect(isComposioNoAuthError(error)).toBe(true);
		expect(error.message).toBe("O Composio recusou o pedido (Auth_Config_NoAuthApp, código 303).");
		expect(error.message).not.toContain("suggested_fix");
		expect(error.message).not.toContain("{");
		expect(isComposioNoAuthError(new ComposioApiError("x", 400, { code: 400 }))).toBe(false);
	});
});

describe("formatComposioError", () => {
	it("resume em pt-BR por status, com slug e código quando vierem", () => {
		expect(formatComposioError(404, JSON.stringify({ error: { slug: "Toolkit_NotFound", code: 305 } })).message).toBe(
			"O Composio não encontrou o recurso pedido (Toolkit_NotFound, código 305).",
		);
		expect(formatComposioError(429, "").message).toBe("O Composio limitou as requisições; tente de novo em instantes (HTTP 429).");
		expect(formatComposioError(503, "<html>bad gateway</html>").message).toBe("O Composio está indisponível no momento (HTTP 503).");
	});

	it("ignora slug com formato estranho e nunca ecoa o corpo ou a chave", async () => {
		const hostile = formatComposioError(400, JSON.stringify({ error: { slug: `bad slug ${API_KEY}`, message: API_KEY } }));
		expect(hostile.message).toBe("O Composio recusou o pedido (HTTP 400).");
		const { client } = clientWith(() => new Response(JSON.stringify({ error: { slug: "X_Y", message: API_KEY } }), { status: 400 }));
		const error = (await client.listToolkits().catch((e: unknown) => e)) as Error;
		expect(error.message).not.toContain(API_KEY);
	});
});

describe("meta-tools do Composio", () => {
	const connection = (tools: string[], catalogId: string | null = "composio", slug = "composio") => ({
		id: `c-${slug}`,
		slug,
		name: slug,
		catalogId,
		disabledTools: [],
		tools: tools.map((name) => ({ name, inputSchema: { type: "object" as const, properties: {} } })),
	});

	it("saem da conexão do Composio, mesmo gravadas antes, e as tools reais ficam", () => {
		const records = withoutNativeDuplicates([
			connection([
				"COMPOSIO_SEARCH_TOOLS",
				"COMPOSIO_MULTI_EXECUTE_TOOL",
				"COMPOSIO_REMOTE_BASH_TOOL",
				"COMPOSIO_REMOTE_WORKBENCH",
				"COMPOSIO_MANAGE_CONNECTIONS",
				"COMPOSIO_GET_TOOL_SCHEMAS",
				"GMAIL_FETCH_EMAILS",
			]),
		]);
		expect(records[0]?.tools.map((t) => t.name)).toEqual(["GMAIL_FETCH_EMAILS"]);
		expect([...buildMcpToolset(records).entries.keys()]).toEqual(["mcp__composio__GMAIL_FETCH_EMAILS"]);
	});

	it("não toca em tools de outros conectores nem em tools de apps com prefixo parecido", () => {
		const other = { ...connection(["COMPOSIO_SEARCH_TOOLS"], "outro", "outro") };
		const records = withoutNativeDuplicates([other, connection(["COMPOSIO_SEARCH_WEB"])]);
		expect(records[0]?.tools).toHaveLength(1);
		expect(records[1]?.tools).toHaveLength(1);
	});
});

describe("user_id do Composio (HMAC)", () => {
	const env = { CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;

	it("é estável, distinto por usuário e não contém o id real", () => {
		const a = composioUserId("user-a", env);
		expect(composioUserId("user-a", env)).toBe(a);
		expect(composioUserId("user-b", env)).not.toBe(a);
		expect(a).toMatch(/^atlas_[0-9a-f]{32}$/);
		expect(a).not.toContain("user-a");
	});

	it("muda com a chave do cofre e falha sem ela", () => {
		const other = { CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;
		expect(composioUserId("user-a", other)).not.toBe(composioUserId("user-a", env));
		expect(() => composioUserId("user-a", {} as NodeJS.ProcessEnv)).toThrow();
	});

	it("monta a URL do servidor e recupera o serverId", () => {
		const url = composioMcpUrl("srv_1", "atlas_u");
		expect(url).toBe("https://backend.composio.dev/v3/mcp/srv_1?user_id=atlas_u");
		expect(composioServerIdFromUrl(url)).toBe("srv_1");
		expect(composioServerIdFromUrl(undefined)).toBeNull();
	});
});

describe("tools do Composio no registry", () => {
	const connection = (tools: string[], catalogId: string | null = "composio", slug = "composio") => ({
		id: `c-${slug}`,
		slug,
		name: slug,
		catalogId,
		disabledTools: [],
		tools: tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
	});

	it("leitura entra direto; escrita pede confirmação", () => {
		const toolset = buildMcpToolset([connection(["GITHUB_LIST_COMMITS", "GITHUB_CREATE_ISSUE", "GMAIL_SEND_EMAIL"])]);
		const read = toolset.entries.get("mcp__composio__GITHUB_LIST_COMMITS");
		const write = toolset.entries.get("mcp__composio__GITHUB_CREATE_ISSUE");
		const send = toolset.entries.get("mcp__composio__GMAIL_SEND_EMAIL");
		expect(read).toMatchObject({ readOnly: true, requiresConfirmation: false });
		expect(write).toMatchObject({ readOnly: false, requiresConfirmation: true });
		expect(send?.requiresConfirmation).toBe(true);
	});

	it("rotina (sem humano) só recebe as leituras", () => {
		const toolset = buildMcpToolset([connection(["GITHUB_LIST_COMMITS", "GITHUB_CREATE_ISSUE"])], { unattended: true });
		expect([...toolset.entries.keys()]).toEqual(["mcp__composio__GITHUB_LIST_COMMITS"]);
	});

	it("pula toolkit com conector nativo conectado, mantém o resto", () => {
		const records = withoutNativeDuplicates([
			connection(["GITHUB_LIST_COMMITS", "GMAIL_FETCH_EMAILS"]),
			connection(["list_repos"], "github", "github"),
		]);
		const toolset = buildMcpToolset(records);
		expect([...toolset.entries.keys()].sort()).toEqual(["mcp__composio__GMAIL_FETCH_EMAILS", "mcp__github__list_repos"]);
	});

	it("sem nativo conectado nada é removido", () => {
		const records = withoutNativeDuplicates([connection(["GITHUB_LIST_COMMITS"])]);
		expect(records[0]?.tools).toHaveLength(1);
	});
});
