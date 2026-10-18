import { describe, expect, it } from "vitest";
import { ComposioInvalidResponseError, composioInvalidResponseMessage, createComposioClient } from "./client.js";

const API_KEY = "cmp_live_super_secret_key_123";
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function clientWith(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
	const calls: { url: URL; init: RequestInit }[] = [];
	const warnings: string[] = [];
	const fetchFn = (async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push({ url, init: init ?? {} });
		return handler(url, init ?? {});
	}) as unknown as typeof fetch;
	const client = createComposioClient({ apiKey: API_KEY, fetchFn, warn: (line) => warnings.push(line) });
	return { client, calls, warnings };
}
type Client = ReturnType<typeof clientWith>["client"];

describe("formatos de resposta aceitos (OpenAPI v3.1 e variantes)", () => {
	it("toolkits: items, data, array puro e description/logo no topo", async () => {
		const row = { slug: "gmail", name: "Gmail", description: "E-mail", logo: "https://x/l.png" };
		const shapes: unknown[] = [{ items: [row] }, { data: [row] }, { data: { items: [row] } }, [row], { toolkits: [row], nextCursor: "n" }];
		for (const shape of shapes) {
			const { client } = clientWith(() => json(shape));
			const page = await client.listToolkits();
			expect(page.items).toEqual([{ slug: "gmail", name: "Gmail", description: "E-mail", logo: "https://x/l.png", noAuth: false }]);
		}
		const empty = clientWith(() => json({ items: [], next_cursor: null }));
		expect(await empty.client.listToolkits()).toEqual({ items: [], nextCursor: null, totalItems: null });
	});

	it("auth config: criação em auth_config.id, authConfig.id, data.id e id", async () => {
		for (const created of [{ auth_config: { id: "ac_1" } }, { authConfig: { id: "ac_1" } }, { data: { id: "ac_1" } }, { id: "ac_1" }]) {
			const { client, calls } = clientWith((_u, init) => (init.method === "GET" ? json({ items: [] }) : json(created, 201)));
			expect(await client.ensureAuthConfig("gmail")).toBe("ac_1");
			expect(calls[0]?.url.searchParams.get("toolkit_slug")).toBe("gmail");
			expect(calls[0]?.url.searchParams.get("is_composio_managed")).toBe("true");
		}
		const listed = clientWith(() => json({ data: [{ id: "ac_old" }] }));
		expect(await listed.client.ensureAuthConfig("gmail")).toBe("ac_old");
	});

	it("link: redirect_url, redirectUrl e data.redirect_url", async () => {
		const url = "https://connect.composio.dev/link/ln_1";
		for (const shape of [
			{ redirect_url: url, connected_account_id: "ca_1", link_token: "t" },
			{ redirectUrl: url, connectedAccountId: "ca_1" },
			{ data: { redirect_url: url, connected_account_id: "ca_1" } },
		]) {
			const { client } = clientWith(() => json(shape, 201));
			const link = await client.createConnectLink({ authConfigId: "ac", composioUser: "atlas_u", callbackUrl: "https://a/cb" });
			expect(link).toEqual({ redirectUrl: url, connectedAccountId: "ca_1" });
		}
	});

	it("contas conectadas: toolkit.slug ou string, status em qualquer caixa, filtro repetido", async () => {
		const { client, calls } = clientWith(() =>
			json({
				items: [
					{ id: "ca_1", status: "active", toolkit: { slug: "GitHub" } },
					{ id: "ca_2", status: "INITIATED", toolkit: "gmail" },
					{ nanoid: "ca_3", toolkit_slug: "slack" },
				],
			}),
		);
		const list = await client.listConnectedAccounts("atlas_u", { statuses: ["ACTIVE", "INITIATED"] });
		expect(list).toEqual([
			{ id: "ca_1", toolkit: "github", status: "ACTIVE" },
			{ id: "ca_2", toolkit: "gmail", status: "INITIATED" },
			{ id: "ca_3", toolkit: "slack", status: "ACTIVE" },
		]);
		expect(calls[0]?.url.searchParams.getAll("statuses")).toEqual(["ACTIVE", "INITIATED"]);
		expect(calls[0]?.url.searchParams.get("user_ids")).toBe("atlas_u");
	});

	it("MCP: id em id, server.id ou data.id; DELETE em /mcp/{id}", async () => {
		for (const shape of [{ id: "srv_1" }, { server: { id: "srv_1" } }, { data: { id: "srv_1" } }]) {
			const { client } = clientWith(() => json(shape, 201));
			expect(await client.createMcpServer({ name: "n", toolkits: [{ slug: "a", authConfigId: "ac" }] })).toBe("srv_1");
		}
		const del = clientWith(() => json({ id: "srv_1" }));
		await del.client.deleteMcpServer("srv_1");
		expect(del.calls[0]?.init.method).toBe("DELETE");
		expect(del.calls[0]?.url.pathname).toBe("/api/v3.1/mcp/srv_1");
	});
});

describe("falhas viram invalid_response:<etapa>:<campo>", () => {
	const KEYLIKE = /(cmp_|sk-|secret|Bearer|user_id=)/i;
	const secretBody = { token: "cmp_live_valor_secreto", nested: { x: "sk-abc" } };
	const link = (c: Client) => c.createConnectLink({ authConfigId: "a", composioUser: "u", callbackUrl: "https://x/cb" });

	async function failure(run: (client: Client) => Promise<unknown>, body: unknown, status = 200, raw?: string) {
		const ctx = clientWith(() => (raw !== undefined ? new Response(raw, { status }) : json(body, status)));
		const error = (await run(ctx.client).catch((e: unknown) => e)) as ComposioInvalidResponseError;
		return { error, warnings: ctx.warnings };
	}

	const cases: [string, string, (c: Client) => Promise<unknown>, unknown][] = [
		["toolkits", "items", (c) => c.listToolkits(), { foo: 1, ...secretBody }],
		["toolkits", "slug", (c) => c.listToolkits(), { items: [{ nome: "x" }] }],
		["auth_config", "items", (c) => c.ensureAuthConfig("g"), { foo: 1, ...secretBody }],
		["auth_config", "id", (c) => c.ensureAuthConfig("g"), { items: [{ uuid: "u" }] }],
		["link", "redirect_url", link, { link_token: "t", ...secretBody }],
		["link", "redirect_url", link, { redirect_url: "javascript:alert(1)" }],
		["connected_accounts", "items", (c) => c.listConnectedAccounts("u"), { foo: 1, ...secretBody }],
		["connected_accounts", "toolkit", (c) => c.listConnectedAccounts("u"), { items: [{ id: "ca" }] }],
		["mcp_create", "id", (c) => c.createMcpServer({ name: "n", toolkits: [] }), { mcp_url: "https://x", ...secretBody }],
		["mcp_url", "id", (c) => c.createMcpServer({ name: "n", toolkits: [] }), { id: "../evil?x=1" }],
	];

	it.each(cases)("%s:%s", async (step, field, run, body) => {
		const { error, warnings } = await failure(run, body);
		expect(error).toBeInstanceOf(ComposioInvalidResponseError);
		expect(error.code).toBe(`invalid_response:${step}:${field}`);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(`step=${step}`);
		expect(warnings[0]).toContain("status=200");
		expect(warnings[0]).not.toMatch(KEYLIKE);
		expect(warnings[0]).not.toContain(API_KEY);
		expect(composioInvalidResponseMessage(error)).toContain(error.code);
	});

	it("corpo que não é JSON vira invalid_response:<etapa>:body sem logar o texto", async () => {
		const { error, warnings } = await failure((c) => c.listToolkits(), null, 200, `<html>${API_KEY}</html>`);
		expect(error.code).toBe("invalid_response:toolkits:body");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).not.toContain(API_KEY);
		expect(warnings[0]).not.toContain("<html>");
	});

	it("o log mostra nomes e tipos de chave, nunca valores", async () => {
		const { warnings } = await failure((c) => c.listToolkits(), { foo: 1, ...secretBody, list: [1, 2] });
		expect(warnings[0]).toContain("foo:number");
		expect(warnings[0]).toContain("nested:object");
		expect(warnings[0]).toContain("list:array(2)");
		expect(warnings[0]).not.toContain("valor_secreto");
	});

	it("erro HTTP com envelope de erro não vira invalid_response e não ecoa a chave", async () => {
		const envelope = { error: { message: `bad ${API_KEY}`, code: 1, slug: "S", status: 500 } };
		const { error } = await failure((c) => c.listToolkits(), envelope, 500);
		expect(error).not.toBeInstanceOf(ComposioInvalidResponseError);
		expect(error.message).toBe("O Composio está indisponível no momento (S, código 1).");
		expect(error.message).not.toContain(API_KEY);
	});
});
