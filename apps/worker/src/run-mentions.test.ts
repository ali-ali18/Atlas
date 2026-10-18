/**
 * `/skill` e `@Bot` do composer: carga determinística da skill e nota de bots citados.
 * Runner: `NODE_ENV=test pnpm exec tsx --test src/run-mentions.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpToolset } from "@workspace/agent-runtime";
import { appMentionNotes, botMentionNote, buildMentionNotes, knownApps, MENTION_SKILL_BODY_MAX_CHARS, parseAppMentions, skillInvocationNote, type MentionAppRef, type MentionNoteDeps } from "./run-mentions.js";

const roster = [
	{ id: "me", name: "Ana" },
	{ id: "b1", name: "Bia" },
	{ id: "b2", name: "Caio Souza" },
];

function deps(overrides: Partial<MentionNoteDeps> = {}): MentionNoteDeps {
	return {
		readSkill: async (userId, name) =>
			userId === "owner" && name === "pesquisar" ? { name, description: "Pesquisa na web", tools: ["web_search"], body: "1. Busque\n2. Resuma" } : null,
		builtinSkill: (slug) => (slug === "memoria" ? { slug, description: "Gerencia memória", body: "Passos da memória" } : undefined),
		roster: async () => roster,
		idleConnections: async () => [],
		...overrides,
	};
}

test("/skill do dono carrega o corpo na nota, com dica de ferramentas e sem reler", async () => {
	const note = await skillInvocationNote({ userId: "owner", botId: "me", name: "pesquisar" }, deps());
	assert.ok(note?.includes('<skill name="pesquisar">'));
	assert.ok(note?.includes("1. Busque"));
	assert.ok(note?.includes("a hint, not a permission"));
	assert.ok(note?.includes("Do not call skill_read"));
	assert.ok(!/atlas/i.test(note ?? ""));
});

test("skill de fábrica carrega quando o dono não tem uma; desconhecida ou de outro dono é ignorada", async () => {
	assert.ok((await skillInvocationNote({ userId: "owner", botId: null, name: "memoria" }, deps()))?.includes("Passos da memória"));
	assert.equal(await skillInvocationNote({ userId: "owner", botId: null, name: "nao-existe" }, deps()), null);
	assert.equal(await skillInvocationNote({ userId: "intruso", botId: null, name: "pesquisar" }, deps()), null);
});

test("a skill do dono vence a de fábrica de mesmo nome", async () => {
	const both = deps({ builtinSkill: (slug) => ({ slug, description: "fábrica", body: "CORPO-FABRICA" }) });
	const note = await skillInvocationNote({ userId: "owner", botId: null, name: "pesquisar" }, both);
	assert.ok(note?.includes("1. Busque") && !note.includes("CORPO-FABRICA"));
});

test("corpo gigante é cortado", async () => {
	const big = deps({ readSkill: async (_u, name) => ({ name, description: "d", tools: [], body: "x".repeat(MENTION_SKILL_BODY_MAX_CHARS * 2) }) });
	const note = (await skillInvocationNote({ userId: "owner", botId: null, name: "pesquisar" }, big)) ?? "";
	assert.ok(note.length < MENTION_SKILL_BODY_MAX_CHARS + 1200);
	assert.ok(note.includes("truncated"));
});

test("@Bot lista os bots citados com id e manda usar send_to_bot; nunca o próprio bot", () => {
	const note = botMentionNote("pergunta pro @Bia e @Caio sobre o caixa", "me", roster);
	assert.ok(note?.includes("Bia (id: b1)") && note.includes("Caio Souza (id: b2)"));
	assert.ok(note?.includes("send_to_bot"));
	assert.equal(botMentionNote("oi @Ana", "me", roster), null, "o bot atual não conta");
	assert.equal(botMentionNote("manda para email@bia.com", "me", roster), null, "e-mail não conta");
	assert.equal(botMentionNote("@Fantasma oi", "me", roster), null, "nome desconhecido é ignorado");
	assert.equal(botMentionNote("@Bia @Bia", "me", roster)?.match(/Bia \(id/g)?.length, 1);
});

test("buildMentionNotes junta skills e bots na ordem; sem tokens não faz leitura", async () => {
	const { notes } = await buildMentionNotes({ userId: "owner", botId: "me", text: "/pesquisar e pergunta ao @Bia" }, deps());
	assert.equal(notes.length, 2);
	assert.ok(notes[0]!.includes("pesquisar") && notes[1]!.includes("b1"));
	const { notes: none } = await buildMentionNotes(
		{ userId: "owner", botId: "me", text: "oi, tudo bem?" },
		deps({
			readSkill: async () => {
				throw new Error("não devia ler");
			},
			roster: async () => {
				throw new Error("não devia ler");
			},
		}),
	);
	assert.deepEqual(none, []);
});

test("falha ao ler skill ou roster não derruba o turno", async () => {
	const broken = deps({
		readSkill: async () => {
			throw new Error("db");
		},
		roster: async () => {
			throw new Error("db");
		},
	});
	assert.deepEqual(await buildMentionNotes({ userId: "owner", botId: "me", text: "/pesquisar @Bia" }, broken), { notes: [], connectors: [] });
});

/** Toolset mínimo: só o que `knownApps` lê (entradas com conector e prefixo Composio). */
function fakeToolset(entries: Array<{ connectionName: string; toolName: string; composio?: boolean }>): McpToolset {
	const map = new Map(
		entries.map((entry, index) => [
			`mcp__t${index}`,
			{ connectionName: entry.connectionName, toolName: entry.toolName, autonomyMeta: { connectors: entry.composio ? ["composio"] : [entry.connectionName] } },
		]),
	);
	return { entries: map } as unknown as McpToolset;
}

const toolset = fakeToolset([
	{ connectionName: "Gmail", toolName: "list_messages" },
	{ connectionName: "Composio", toolName: "GOOGLESHEETS_GET_SHEET", composio: true },
]);

test("@App conectado: acha por nome sem acento/caixa/espaço, inclusive app do Composio, e carrega o conector", async () => {
	const turn = await buildMentionNotes({ userId: "owner", botId: "me", text: "lê meu @gmail e joga na @Google Sheets", toolset }, deps());
	assert.deepEqual(turn.connectors, ["Gmail", "GOOGLESHEETS"]);
	assert.equal(turn.notes.length, 1);
	assert.ok(turn.notes[0]!.includes('"Gmail"') && turn.notes[0]!.includes("already loaded") && turn.notes[0]!.includes("without mcp_tool_search"));
});

test("@App sem conexão (catálogo ou login pendente): nota manda mostrar o cartão e nada é carregado", async () => {
	const turn = await buildMentionNotes(
		{ userId: "owner", botId: "me", text: "usa o @Notion e o @Meu Servidor", toolset },
		deps({ idleConnections: async () => [{ name: "Meu Servidor" }] }),
	);
	assert.deepEqual(turn.connectors, []);
	assert.equal(turn.notes.length, 1);
	assert.ok(turn.notes[0]!.includes("propose_connector") && turn.notes[0]!.includes('"Notion"') && turn.notes[0]!.includes('"Meu Servidor"'));
});

test("nome de bot vence nome de app; e-mail, código e nome desconhecido não contam", async () => {
	const apps: MentionAppRef[] = [{ name: "Bia", connector: "Bia", connected: true }, { name: "Gmail", connector: "Gmail", connected: true }];
	assert.deepEqual(parseAppMentions("fala com @Bia", apps, { names: ["Bia"] }), []);
	assert.deepEqual(parseAppMentions("fala com @Bia", apps, { mentions: [{ botId: "b1", name: "Bia", start: 9, end: 13 }], names: ["Bia"] }), []);
	assert.deepEqual(parseAppMentions("manda para fulano@gmail.com", apps), []);
	assert.deepEqual(parseAppMentions(["```", "@Gmail", "```"].join("\n"), apps), []);
	assert.deepEqual(parseAppMentions("@Gmailzinho e @Fantasma", apps), []);
	assert.deepEqual(parseAppMentions("@Gmail @gmail", apps).map((app) => app.name), ["Gmail"]);
	const clash = await buildMentionNotes(
		{ userId: "owner", botId: "me", text: "pergunta ao @Bia", toolset: fakeToolset([{ connectionName: "Bia", toolName: "x" }]) },
		deps(),
	);
	assert.deepEqual(clash.connectors, []);
	assert.ok(clash.notes[0]!.includes("send_to_bot"));
});

test("knownApps: conectado vence o pendente de mesmo nome; sem toolset só catálogo e pendentes", () => {
	const apps = knownApps(toolset, [{ name: "Gmail" }]);
	assert.equal(apps.find((app) => app.name === "Gmail")?.connected, true);
	assert.ok(knownApps(null, []).every((app) => !app.connected));
	assert.deepEqual(appMentionNotes([]), []);
});
