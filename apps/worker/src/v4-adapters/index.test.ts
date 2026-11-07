/**
 * Montagem do preset `full` com as portas do worker (adaptadores com db/clientes falsos; sem rede).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/index.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteStore } from "@workspace/agent";
import { buildV4Registry, type V4AdapterDeps } from "./index.js";

type Connected = Awaited<ReturnType<V4AdapterDeps["mcp"]["listConnected"]>>;

export function fakeAdapterDeps(options: { connections?: Connected; listFails?: boolean } = {}): V4AdapterDeps {
	const connections: Connected = options.connections ?? [
		{ id: "c1", slug: "agenda", name: "Agenda", catalogId: null, status: "connected", confirmWrites: true, tools: [{ name: "create_event", inputSchema: { type: "object", properties: {} } }], disabledTools: [], toolMarks: {} } as unknown as Connected[number],
	];
	const never = () => assert.fail("o adaptador não deveria ser chamado na montagem");
	return {
		web: { extract: async (url) => ({ url, markdown: "# Página", truncated: false }), searxng: async () => [{ url: "https://example.test/r", title: "R", snippet: "s" }] },
		deliverables: { persistArtifact: never, nextVersion: never, countRunFiles: never, loadArtifact: never, createPage: never, render: never, preview: never, persistCard: never } as unknown as V4AdapterDeps["deliverables"],
		memory: { snapshot: never, add: never, getById: never, replaceById: never, removeById: never } as unknown as V4AdapterDeps["memory"],
		notebook: { create: never, get: never, search: never, update: never, remove: never, listPinned: never } as unknown as V4AdapterDeps["notebook"],
		settings: { getBot: never, update: never } as unknown as V4AdapterDeps["settings"],
		mcp: {
			listConnected: async () => {
				if (options.listFails) throw new Error("db fora do ar com token ghp_abcdefghijklmnopqrstuvwxyz0123456789");
				return connections;
			},
			loadRuntime: async () => null,
		},
	};
}

const notes = {} as NoteStore;
// O engine sempre passa a fábrica de ajudantes (a pesquisa depende dela); sem ela, `research` fica indisponível.
const base = { runId: "run-1", userId: "user-a", conversationId: "conv-1", unattended: false, notes, emit: () => undefined, makeHelpers: () => ({ runAll: async () => [] }) };

test("com bot e portas reais montadas, o preset full não tem capacidade indisponível", async () => {
	const logs: string[] = [];
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), log: (m) => void logs.push(m) });
	assert.deepEqual(setup.unavailable, []);
	assert.deepEqual(logs, []);
	assert.deepEqual(setup.registry.ids(), ["connectors", "deliverables", "memory", "research", "settings", "tasks", "web"]);
	assert.match(setup.stableSystem, /Work contract/);
	assert.match(setup.stableSystem, /connectors/);
	// confirmWrites do conector vira `confirm: "always"` na tool genérica de escrita
	assert.equal(setup.registry.toolByName("mcp_agenda_write")?.confirm, "always");
});

test("sem bot no run: configurações ficam de fora e vão ao log técnico", async () => {
	const logs: string[] = [];
	const setup = await buildV4Registry({ ...base, deps: fakeAdapterDeps(), log: (m) => void logs.push(m) });
	assert.deepEqual(setup.unavailable, ["settings"]);
	assert.equal(logs.length, 1);
	assert.match(logs[0] as string, /capacidades sem porta: settings/);
	assert.ok(!setup.registry.ids().includes("settings"));
});

test("dono sem conexão: sem capacidade connectors nem regra", async () => {
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps({ connections: [] }) });
	assert.ok(!setup.registry.ids().includes("connectors"));
});

test("falha ao listar conexões não derruba o run e o log não carrega o segredo do erro", async () => {
	const logs: string[] = [];
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps({ listFails: true }), log: (m) => void logs.push(m) });
	assert.ok(!setup.registry.ids().includes("connectors"));
	assert.equal(logs.length, 1);
	assert.match(logs[0] as string, /conectores indisponíveis/);
	assert.ok(!logs[0]?.includes("ghp_"));
});

test("conexão de outro dono devolvida pela porta é descartada (defesa em profundidade da capacidade)", async () => {
	const deps = fakeAdapterDeps();
	const other = { ...(await deps.mcp.listConnected("user-a"))[0], id: "c9" } as Connected[number];
	// a porta amarra o dono: pedir como user-b nunca devolve as conexões de user-a
	const setup = await buildV4Registry({ ...base, userId: "user-b", botId: "bot-1", deps: { ...deps, mcp: { ...deps.mcp, listConnected: async (userId) => (userId === "user-a" ? [other] : []) } } });
	assert.ok(!setup.registry.ids().includes("connectors"));
});

test("ajudantes: a fábrica recebe a mesma porta de busca da mãe, uma vez por montagem", async () => {
	const seen: unknown[] = [];
	const helpers = { runAll: async () => [] };
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), makeHelpers: ({ search }) => (seen.push(search), helpers) });
	assert.equal(seen.length, 1);
	assert.equal(typeof (seen[0] as { extract: unknown }).extract, "function");
	assert.deepEqual(setup.unavailable, []);
	// sem a fábrica, nada muda
	await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.equal(seen.length, 1);
});
