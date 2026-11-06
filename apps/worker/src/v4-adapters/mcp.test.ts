/**
 * Ponte MCP do v4 no worker, com o runtime do v2 e o db falsos (sem rede nem cofre).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/mcp.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpRuntime, McpRuntimeOptions } from "@workspace/agent-runtime";
import { createV4Mcp, type V4McpDeps } from "./mcp.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

type Record_ = Awaited<ReturnType<V4McpDeps["listConnected"]>>[number];
const record = (id: string, slug: string, over: Partial<Record_> = {}): Record_ =>
	({ id, slug, name: slug, catalogId: null, status: "connected", confirmWrites: true, tools: [{ name: "list_events", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }], disabledTools: [], toolMarks: {}, ...over }) as unknown as Record_;

function harness(options: { callResult?: { ok: boolean; text: string }; throwOnCall?: Error; loaded?: boolean } = {}) {
	const owners: Record<string, Record_[]> = { "user-a": [record("c1", "agenda")], "user-b": [record("c2", "outra")] };
	const loadOptions: McpRuntimeOptions[] = [];
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const runtime = {
		toolset: { entries: new Map([["mcp__agenda__list_events", { connectionId: "c1", toolName: "list_events" }]]) },
		call: async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			if (options.throwOnCall) throw options.throwOnCall;
			return { truncated: false, ...(options.callResult ?? { ok: true, text: "3 eventos" }) };
		},
	} as unknown as McpRuntime;
	const deps: V4McpDeps = {
		listConnected: async (userId) => owners[userId] ?? [],
		loadRuntime: async (opts) => {
			loadOptions.push(opts);
			return options.loaded === false ? null : runtime;
		},
	};
	return { deps, loadOptions, calls };
}

test("lista só as conexões do dono do run, sem segredo nem URL", async () => {
	const h = harness();
	const mcp = createV4Mcp({ scope: { ownerId: "user-a", unattended: false }, deps: h.deps });
	const listed = await mcp.listConnections("user-a");
	assert.deepEqual(listed.map((c) => ({ id: c.id, ownerId: c.ownerId, slug: c.slug, confirmWrites: c.confirmWrites })), [{ id: "c1", ownerId: "user-a", slug: "agenda", confirmWrites: true }]);
	assert.ok(!JSON.stringify(listed).includes("secretsEnc"));
	assert.ok(!("url" in (listed[0] as object)));
	// IDOR: outro dono pedindo pela mesma porta recebe vazio
	assert.deepEqual(await mcp.listConnections("user-b"), []);
	assert.equal(h.loadOptions.length, 0, "listar não abre o cofre");
});

test("chama a tool pelo nome exposto do runtime, com o dono, o bot e a conversa do run", async () => {
	const h = harness();
	const mcp = createV4Mcp({ scope: { ownerId: "user-a", unattended: false, botId: "bot-1", botName: "Atlas", conversationId: "conv-1" }, deps: h.deps });
	assert.deepEqual(await mcp.call("user-a", "c1", "list_events", { dia: "hoje" }), { ok: true, text: "3 eventos" });
	assert.deepEqual(h.calls, [{ name: "mcp__agenda__list_events", args: { dia: "hoje" } }]);
	assert.deepEqual(h.loadOptions, [{ userId: "user-a", unattended: false, botId: "bot-1", botName: "Atlas", conversationId: "conv-1" }]);
	await mcp.call("user-a", "c1", "list_events", {});
	assert.equal(h.loadOptions.length, 1, "o runtime é aberto uma vez por run");
});

test("IDOR: outro dono e conexão que não é do dono não chamam nada", async () => {
	const h = harness();
	const mcp = createV4Mcp({ scope: { ownerId: "user-a", unattended: false }, deps: h.deps });
	assert.deepEqual(await mcp.call("user-b", "c1", "list_events", {}), { ok: false, error: "This app belongs to another owner." });
	const other = await mcp.call("user-a", "c2", "list_events", {});
	assert.equal(other.ok, false);
	assert.equal(h.calls.length, 0);
});

test("rotina (sem o dono): runtime aberto como unattended; tool de escrita não existe e o motivo diz que só lê", async () => {
	const h = harness();
	const mcp = createV4Mcp({ scope: { ownerId: "user-a", unattended: true }, deps: h.deps });
	assert.equal(h.loadOptions.length, 0);
	const result = await mcp.call("user-a", "c1", "create_event", { titulo: "x" });
	assert.equal(result.ok, false);
	assert.match((result as { error: string }).error, /only reading is allowed/);
	assert.equal(h.loadOptions[0]?.unattended, true);
	assert.equal(h.calls.length, 0);
});

test("segredo em erro do conector é redigido (texto de falha e exceção)", async () => {
	const failed = createV4Mcp({ scope: { ownerId: "user-a", unattended: false }, deps: harness({ callResult: { ok: false, text: `401 com Authorization: Bearer ${SECRET}` } }).deps });
	const first = await failed.call("user-a", "c1", "list_events", {});
	assert.equal(first.ok, false);
	assert.ok(!JSON.stringify(first).includes(SECRET));
	assert.match((first as { error: string }).error, /\[redacted\]/);

	const thrown = createV4Mcp({ scope: { ownerId: "user-a", unattended: false }, deps: harness({ throwOnCall: new Error(`boom ${SECRET}`) }).deps });
	const second = await thrown.call("user-a", "c1", "list_events", {});
	assert.equal(second.ok, false);
	assert.ok(!JSON.stringify(second).includes(SECRET));

	const leaked = createV4Mcp({ scope: { ownerId: "user-a", unattended: false }, deps: harness({ callResult: { ok: true, text: `token ${SECRET}` } }).deps });
	assert.ok(!JSON.stringify(await leaked.call("user-a", "c1", "list_events", {})).includes(SECRET));
});

test("sem cofre/runtime: falha honesta, sem lançar", async () => {
	const mcp = createV4Mcp({ scope: { ownerId: "user-a", unattended: false }, deps: harness({ loaded: false }).deps });
	const result = await mcp.call("user-a", "c1", "list_events", {});
	assert.equal(result.ok, false);
	assert.match((result as { error: string }).error, /not available right now/);
});
