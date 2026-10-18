import { describe, expect, it } from "vitest";
import type { McpConnectionRecord } from "@workspace/db";
import { COMPOSIO_CATALOG_ID, parseLoginConnector } from "@workspace/shared";
import { connectorResumeMessage, proposeConnector, proposeCustomMcp, type ProposeConnectorContext } from "./propose-connector.js";

const ctx = (over: Partial<ProposeConnectorContext> = {}): ProposeConnectorContext => ({
	userId: "u1",
	runId: "r1",
	origin: "chat",
	loginAsked: new Set(),
	...over,
});
const noConnections = { listConnections: async () => [] as McpConnectionRecord[] };
const valid = { name: "Acme", url: "https://mcp.acme.example/mcp", auth: "oauth", reason: "Ler pedidos" };

describe("proposeCustomMcp", () => {
	it("emite o card genérico com ícone via proxy, URL e auth", async () => {
		const out = await proposeCustomMcp(valid, ctx(), noConnections, { NODE_ENV: "production" });
		expect(out.summary).toContain("card for Acme was sent");
		const connector = parseLoginConnector(out.loginEvent?.connector);
		expect(connector).toMatchObject({
			kind: "custom",
			id: "mcp-acme-example",
			name: "Acme",
			url: "https://mcp.acme.example/mcp",
			auth: "oauth",
			icon: "/v1/mcp/icon/mcp.acme.example",
			description: "Ler pedidos",
		});
		expect(out.loginEvent?.status).toBe("pending");
	});

	it.each([
		["http://mcp.acme.example/mcp"],
		["https://localhost/mcp"],
		["https://192.168.0.5/mcp"],
		["https://10.0.0.1/mcp"],
		["https://intranet/mcp"],
		["https://user:pw@mcp.acme.example/mcp"],
		["https://mcp.acme.example/mcp?token=x"],
		["not a url"],
	])("recusa %s em produção", async (url) => {
		await expect(proposeCustomMcp({ ...valid, url }, ctx(), noConnections, { NODE_ENV: "production" })).rejects.toThrow(/URL inválida/);
	});

	it("aceita localhost só fora de produção", async () => {
		const url = "http://localhost:8080/mcp";
		await expect(proposeCustomMcp({ ...valid, url }, ctx(), noConnections, { NODE_ENV: "production" })).rejects.toThrow();
		await expect(proposeCustomMcp({ ...valid, url }, ctx(), noConnections, { NODE_ENV: "development" })).resolves.toBeTruthy();
	});

	it("valida nome e só funciona no chat do dono", async () => {
		await expect(proposeCustomMcp({ ...valid, name: " " }, ctx(), noConnections)).rejects.toThrow(/Nome/);
		await expect(proposeCustomMcp(valid, ctx({ origin: "routine" }), noConnections, { NODE_ENV: "production" })).rejects.toThrow(/chat/);
		await expect(proposeCustomMcp(valid, ctx({ userId: "default" }), noConnections, { NODE_ENV: "production" })).rejects.toThrow(/chat/);
	});

	it("não repete o card no mesmo run e não oferece se já conectado", async () => {
		const c = ctx();
		await proposeCustomMcp(valid, c, noConnections, { NODE_ENV: "production" });
		await expect(proposeCustomMcp(valid, c, noConnections, { NODE_ENV: "production" })).rejects.toThrow(/already shown/);
		const connected = { listConnections: async () => [{ name: "Acme", url: "https://mcp.acme.example/mcp/", catalogId: null, status: "connected" } as McpConnectionRecord] };
		const out = await proposeCustomMcp(valid, ctx(), connected, { NODE_ENV: "production" });
		expect(out.loginEvent).toBeUndefined();
		expect(out.summary).toContain("already connected");
	});

	it("retoma com mensagem sem afirmar sucesso sem checar", () => {
		const connector = parseLoginConnector({ kind: "custom", id: "acme", name: "Acme", url: valid.url, auth: "oauth" })!;
		expect(connectorResumeMessage({ connector })).toContain('connector "Acme"');
	});
});

describe("proposeConnector sem conector", () => {
	it("aponta para propose_custom_mcp em vez de outro app", async () => {
		const out = await proposeConnector({ app: "Zzzz Service" }, ctx(), {
			listConnections: async () => [{ catalogId: COMPOSIO_CATALOG_ID, secretsEnc: "x", status: "connected", tools: [], disabledTools: [] } as unknown as McpConnectionRecord],
			searchToolkits: async () => [],
			openApiKey: () => null,
		});
		expect(out.summary).toContain("propose_custom_mcp");
		expect(out.summary).toContain("ask the user");
	});
});
