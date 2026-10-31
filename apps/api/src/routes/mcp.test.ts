import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpConnectionRecord } from "@workspace/db";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const {
	createMcpRoutes,
	mcpWebOrigin,
	parseCreateMcpBody,
	parsePatchMcpBody,
	publicCatalogEntry,
	sanitizeMcpTools,
	triageToolMarkPatch,
} = await import("./mcp.js");
const { toMcpConnectionView } = await import("@workspace/db");

test("conector personalizado exige HTTPS, exceto servidor local", () => {
	assert.ok(parseCreateMcpBody({ custom: { name: "X", url: "http://example.com/mcp" } }).error);
	assert.ok(parseCreateMcpBody({ custom: { name: "X", url: "http://localhost:3333/mcp" } }).value);
	assert.ok(parseCreateMcpBody({ custom: { name: "X", url: "http://127.0.0.1:3333/mcp" } }).value);
	assert.ok(parseCreateMcpBody({ custom: { name: "X", url: "https://example.com/mcp" } }).value);
});

test("URL e header com credenciais são validados", () => {
	assert.ok(parseCreateMcpBody({ custom: { name: "X", url: "https://key@example.com/mcp" } }).error);
	assert.ok(parseCreateMcpBody({ custom: { name: "X", url: "https://example.com/mcp?key=secret" } }).error);
	assert.ok(parseCreateMcpBody({ custom: { name: "X", url: "https://example.com/mcp", headerName: "X-Token" } }).error);
	assert.ok(parseCreateMcpBody({ custom: { name: "X", url: "https://example.com/mcp", headerName: "X-Token", headerValue: "abc" } }).value);
	assert.ok(parseCreateMcpBody({ custom: { name: "X", url: "https://example.com/mcp", headerName: "Bad Header", headerValue: "abc" } }).error);
});

test("PATCH aceita marcação de leitura só com read/write e no máximo 200 tools", () => {
	assert.deepEqual(parsePatchMcpBody({ toolMarks: { listar_pedidos: "read", criar_pedido: "write" } }).value, { toolMarks: { listar_pedidos: "read", criar_pedido: "write" } });
	assert.ok(parsePatchMcpBody({ toolMarks: { a: "readonly" } }).error);
	assert.ok(parsePatchMcpBody({ toolMarks: ["read"] }).error);
	assert.ok(parsePatchMcpBody({ toolMarks: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`t${i}`, "read"])) }).error);
});

test("PATCH limita nomes de tools e tipos", () => {
	assert.ok(parsePatchMcpBody({ disabledTools: Array(201).fill("tool") }).error);
	assert.ok(parsePatchMcpBody({ disabledTools: ["tool", 1] }).error);
	assert.ok(parsePatchMcpBody({ confirmWrites: "yes" }).error);
	assert.deepEqual(parsePatchMcpBody({ disabledTools: ["tool"], confirmWrites: false }).value,
		{ disabledTools: ["tool"], confirmWrites: false });
});

test("metadados MCP não devolvem segredos ecoados pelo servidor", () => {
	const secret = "very/secret+token";
	const encodedSecret = encodeURIComponent(secret);
	const tools = sanitizeMcpTools([{
		name: `tool-${secret}`,
		description: `URL segment ${encodedSecret}`,
		inputSchema: { type: "object", description: `use ${secret}` },
	}], [secret, encodedSecret]);
	assert.ok(!JSON.stringify({ connection: { tools } }).includes(secret));
	assert.ok(!JSON.stringify({ connection: { tools } }).includes(encodedSecret));
});

test("payloads públicos omitem template e segredo cifrado", () => {
	const key = "test-private-key-123";
	const entry = publicCatalogEntry({
		id: "example", name: "Example", description: "Busca", longDescription: "Busca na web.",
		category: "search", icon: "search", developer: "Example", website: "example.com",
		sourceUrl: "https://example.com/source", skills: [],
		authType: "api_key", availability: "available", docsUrl: "https://example.com",
		apiKey: { label: "Chave", helpUrl: "https://example.com/key", placement: { kind: "url", template: "https://example.com/sensitive/{key}" } },
	});
	assert.ok(!JSON.stringify(entry).includes("template"));
	const record: McpConnectionRecord = {
		id: "1", catalogId: "example", slug: "example", name: "Example", url: "https://example.com/***/mcp",
		authType: "api_key", status: "connected", tools: [], disabledTools: [], confirmWrites: true,
		lastError: null, accountLabel: null, createdAt: "2026-01-01", updatedAt: "2026-01-01",
		secretsEnc: key, oauthStateHash: null,
	};
	assert.ok(!JSON.stringify({ connection: toMcpConnectionView(record) }).includes(key));
});

test("mcpWebOrigin deriva de ATLAS_URL (sem barra final), com fallback pro dev padrão", () => {
	assert.equal(mcpWebOrigin({ ATLAS_URL: "https://atlas.example.com/" } as NodeJS.ProcessEnv), "https://atlas.example.com");
	assert.equal(mcpWebOrigin({ ATLAS_URL: "https://atlas.example.com" } as NodeJS.ProcessEnv), "https://atlas.example.com");
	assert.equal(mcpWebOrigin({} as NodeJS.ProcessEnv), "http://localhost:3000");
});

test("GET /v1/mcp/oauth/callback sem sessão nunca reivindica o state (guarda defensivo do handler)", async () => {
	// Em produção o requireUser global (apps/api/src/index.ts) já bloqueia
	// isso antes de chegar aqui (a rota não é mais pública — ver
	// middleware/auth.test.ts); este teste cobre o app do MCP isolado, como
	// alguém montaria numa rota sem o middleware global por engano.
	const app = createMcpRoutes();
	const res = await app.request("/v1/mcp/oauth/callback?state=algum-state&code=algum-code");
	assert.equal(res.status, 400);
	const html = await res.text();
	assert.ok(html.includes("Entre no Atlas e tente de novo"));
});

test("PATCH de marcação: tool que sumiu é ignorada e devolvida; anotada pelo servidor ou irreversível continua recusada", () => {
	const tools = [
		{ name: "listar_pedidos" },
		{ name: "ping", annotations: { readOnlyHint: true } },
		{ name: "enviar_nfe" },
	];
	const ok = triageToolMarkPatch(tools, { listar_pedidos: "read", antiga: "read", velha: "write" });
	assert.deepEqual(ok, { ignoredTools: ["antiga", "velha"], rejected: [] });
	const bad = triageToolMarkPatch(tools, { listar_pedidos: "read", ping: "write", enviar_nfe: "read", antiga: "read" });
	assert.deepEqual(bad.ignoredTools, ["antiga"]);
	assert.equal(bad.rejected.length, 2);
	assert.match(bad.rejected.join(" "), /ping.*conector já informa/);
	assert.match(bad.rejected.join(" "), /enviar_nfe.*não dá para desfazer/);
});
