/**
 * Montagem do preset `full` com as portas do worker (adaptadores com db/clientes falsos; sem rede).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/index.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteStore } from "@workspace/agent";
import { buildV4Registry, type V4AdapterDeps } from "./index.js";

type Connected = Awaited<ReturnType<V4AdapterDeps["mcp"]["listConnected"]>>;

export function fakeAdapterDeps(options: { connections?: Connected; listFails?: boolean; decideForOthers?: boolean } = {}): V4AdapterDeps {
	const connections: Connected = options.connections ?? [
		{ id: "c1", slug: "agenda", name: "Agenda", catalogId: null, status: "connected", confirmWrites: true, tools: [{ name: "create_event", inputSchema: { type: "object", properties: {} } }], disabledTools: [], toolMarks: {} } as unknown as Connected[number],
	];
	const never = () => assert.fail("o adaptador não deveria ser chamado na montagem");
	return {
		web: { extract: async (url) => ({ url, markdown: "# Página", truncated: false }), searxng: async () => [{ url: "https://example.test/r", title: "R", snippet: "s" }] },
		deliverables: { persistArtifact: never, nextVersion: never, countRunFiles: never, loadArtifact: never, createPage: never, render: never, preview: never, persistCard: never } as unknown as V4AdapterDeps["deliverables"],
		memory: { snapshot: never, add: never, getById: never, replaceById: never, removeById: never } as unknown as V4AdapterDeps["memory"],
		notebook: { create: never, get: never, search: never, update: never, remove: never, listPinned: never } as unknown as V4AdapterDeps["notebook"],
		settings: { getBot: never, update: never, getPolicy: never, setCodeMode: never } as unknown as V4AdapterDeps["settings"],
		mcp: {
			listConnected: async () => {
				if (options.listFails) throw new Error("db fora do ar com token ghp_abcdefghijklmnopqrstuvwxyz0123456789");
				return connections;
			},
			loadRuntime: async () => null,
		},
		agenda: { loadSettings: never, create: never, list: never, change: never, record: never } as unknown as V4AdapterDeps["agenda"],
		shopping: { fetchHtml: never, record: never, attachWatch: never, list: never, persistCard: never } as unknown as V4AdapterDeps["shopping"],
		email: { listConnected: never, accessToken: never, googleFetch: never, googleJson: never, getMailbox: never, botMail: never, persistCard: never } as unknown as V4AdapterDeps["email"],
		calendar: { listConnected: never, accessToken: never, fetchFn: never, loadSettings: never, persistCard: never } as unknown as V4AdapterDeps["calendar"],
		brief: { listPurchases: never, listAgendaItems: never, conversationTasks: never, persistCard: never } as unknown as V4AdapterDeps["brief"],
		images: { generate: never, process: never, persistArtifact: never, persistCard: never } as unknown as V4AdapterDeps["images"],
		vault: { listMeta: async () => [], getByName: never, getKey: never, touch: never, audit: never, unwrap: never, open: never, saveIntent: never, persistCard: never } as unknown as V4AdapterDeps["vault"],
		github: { resolveReadOps: never, markAuthFailed: never } as unknown as V4AdapterDeps["github"],
		bots: { roster: never, send: never, setPrimary: never, decidesForOthers: async () => options.decideForOthers === true, findPending: never, attended: never, autoCount: never, queueAuto: never, escalate: never, botName: never, listSkills: never, persistCard: never } as unknown as V4AdapterDeps["bots"],
		routines: { list: async () => [], update: never, remove: never, listGroups: async () => [], createGroup: never, updateGroup: never, deleteGroup: never, setGroupEnabled: never, persistCard: never, now: () => new Date() } as unknown as V4AdapterDeps["routines"],
		skills: { list: async () => [], read: never, apply: never, remove: never, persistCard: never } as unknown as V4AdapterDeps["skills"],
	};
}

const notes = {} as NoteStore;
// O engine sempre passa a fábrica de ajudantes (a pesquisa depende dela); sem ela, `research` fica indisponível.
const base = { runId: "run-1", userId: "user-a", conversationId: "conv-1", unattended: false, browser: true, notes, emit: () => undefined, makeHelpers: () => ({ runAll: async () => [] }) };

test("com bot e portas reais montadas, o preset full não tem capacidade indisponível", async () => {
	const logs: string[] = [];
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), log: (m) => void logs.push(m) });
	assert.deepEqual(setup.unavailable, []);
	assert.deepEqual(logs, []);
	assert.deepEqual(setup.registry.ids(), ["agenda", "bots", "browser", "calendar", "connectors", "deliverables", "email", "github", "images", "memory", "research", "routines", "settings", "shopping", "skills", "tasks", "vault", "video", "web"]);
	assert.match(setup.stableSystem, /Work contract/);
	assert.match(setup.stableSystem, /connectors/);
	// confirmWrites do conector vira `confirm: "always"` na tool genérica de escrita
	assert.equal(setup.registry.toolByName("mcp_agenda_write")?.confirm, "always");
});

test("sem bot no run: configurações ficam de fora e vão ao log técnico", async () => {
	const logs: string[] = [];
	const setup = await buildV4Registry({ ...base, deps: fakeAdapterDeps(), log: (m) => void logs.push(m) });
	// Configurações, agenda, bots e rotinas são do bot do run: sem bot, as quatro ficam de fora.
	assert.deepEqual(setup.unavailable, ["settings", "agenda", "bots", "routines"]);
	assert.equal(logs.length, 1);
	assert.match(logs[0] as string, /capacidades sem porta: settings, agenda, bots, routines/);
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

test("agenda (F4.2): capacidade lazy no preset full; sem bot não entra e vai para 'unavailable'", async () => {
	const withBot = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.ok(withBot.registry.ids().includes("agenda"));
	assert.ok(!withBot.registry.core().some((c) => c.id === "agenda"));
	assert.match(withBot.stableSystem, /- agenda:/);
	const noBot = await buildV4Registry({ ...base, deps: fakeAdapterDeps(), log: () => undefined });
	assert.ok(noBot.unavailable.includes("agenda"));
	assert.ok(!noBot.registry.ids().includes("agenda"));
});

test("run de agenda: agenda_result entra no núcleo e a capacidade agenda sai (nada de item criado em cadeia)", async () => {
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), unattended: true, agendaRun: true });
	assert.ok(setup.registry.ids().includes("agenda-run"));
	assert.ok(!setup.registry.ids().includes("agenda"));
	assert.deepEqual(setup.registry.core().map((c) => c.id).sort(), ["agenda-run", "web"].sort());
	assert.equal(setup.registry.toolByName("remind_me"), undefined);
	assert.equal(setup.registry.toolByName("agenda_result")?.name, "agenda_result");
	assert.doesNotMatch(setup.stableSystem, /- agenda:/);
});

test("chat comum não tem agenda_result", async () => {
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.equal(setup.registry.toolByName("agenda_result"), undefined);
});

test("run de agenda sem nenhum conector conectado: a troca de agenda por agenda-run também vale (auditoria do próprio F4.3)", async () => {
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps({ connections: [] }), unattended: true, agendaRun: true });
	assert.ok(!setup.registry.ids().includes("connectors"));
	assert.ok(setup.registry.ids().includes("agenda-run"));
	assert.ok(!setup.registry.ids().includes("agenda"));
});

test("e-mail (F7.1): lazy no chat com as cinco tools; no run de agenda só lê (sem rascunho nem envio) e sem bot segue valendo o Gmail", async () => {
	const chat = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.ok(!chat.registry.core().some((c) => c.id === "email"));
	assert.match(chat.stableSystem, /- email:/);
	for (const name of ["email_list", "email_read", "email_triage", "email_draft", "email_send"]) assert.ok(chat.registry.toolByName(name), name);
	assert.equal(chat.registry.toolByName("email_send")?.effect, "send");
	assert.equal(chat.registry.toolByName("email_send")?.confirm, "always");
	const wake = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), unattended: true, agendaRun: true });
	assert.deepEqual(wake.registry.ids().includes("email"), true);
	for (const name of ["email_list", "email_read", "email_triage"]) assert.ok(wake.registry.toolByName(name), name);
	for (const name of ["email_draft", "email_send"]) assert.equal(wake.registry.toolByName(name), undefined, name);
	const noBot = await buildV4Registry({ ...base, deps: fakeAdapterDeps(), log: () => undefined });
	assert.ok(noBot.registry.ids().includes("email"));
});

test("calendário (F7.1): lazy no chat; 'Bom dia' não carrega as tools dele", async () => {
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.ok(setup.registry.ids().includes("calendar"));
	assert.ok(!setup.registry.core().some((c) => c.id === "calendar"));
	assert.match(setup.stableSystem, /- calendar:/);
	assert.equal(setup.stableSystem.includes("calendar_create"), false);
	assert.deepEqual(setup.registry.toolByName("calendar_create")?.effect, "write_external");
});

test("run de agenda comum: calendário só lê (sem criar, alterar nem apagar)", async () => {
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), unattended: true, agendaRun: true, agendaKind: "watch" });
	assert.equal(setup.registry.toolByName("calendar_list")?.effect, "read");
	for (const name of ["calendar_create", "calendar_update", "calendar_delete"]) assert.equal(setup.registry.toolByName(name), undefined);
});

test("run do plano do dia (brief): só agenda_result, brief_sources e day_plan; sem web, escrita nem conectores", async () => {
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), unattended: true, agendaRun: true, agendaKind: "brief" });
	assert.deepEqual(setup.registry.ids(), ["agenda-run", "brief"]);
	assert.deepEqual(setup.registry.core().map((c) => c.id).sort(), ["agenda-run", "brief"]);
	assert.equal(setup.registry.toolByName("day_plan")?.endsRun, true);
	for (const name of ["web_search", "remind_me", "calendar_create", "record_purchase"]) assert.equal(setup.registry.toolByName(name), undefined);
});

test("brief com a fonte de e-mail da outra frente: entra na leitura; sem ela o registro é o mesmo", async () => {
	const calls: string[] = [];
	const email = { listRecent: async (userId: string) => (calls.push(userId), []) };
	const withEmail = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), unattended: true, agendaRun: true, agendaKind: "brief", briefEmail: email });
	const without = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), unattended: true, agendaRun: true, agendaKind: "brief" });
	assert.deepEqual(withEmail.registry.ids(), without.registry.ids());
});

test("com email e calendar nativos no run, os conectores embutidos Gmail e Google Agenda saem (não contornam a aprovação)", async () => {
	const embedded = (id: string, slug: string, tools: string[]) =>
		({ id, slug, name: slug, catalogId: slug, status: "connected", confirmWrites: false, tools: tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })), disabledTools: [], toolMarks: {} }) as unknown as Connected[number];
	const connections = [embedded("g1", "gmail", ["create_draft", "search_messages"]), embedded("g2", "google_calendar", ["create_event"]), embedded("g3", "google_drive", ["search_files"])];
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps({ connections }), log: () => undefined });
	assert.ok(setup.registry.ids().includes("email") && setup.registry.ids().includes("calendar"));
	assert.equal(setup.registry.toolByName("mcp_gmail_write"), undefined);
	assert.equal(setup.registry.toolByName("mcp_gmail_read"), undefined);
	assert.equal(setup.registry.toolByName("mcp_google_calendar_write"), undefined);
	assert.ok(setup.registry.toolByName("mcp_google_drive_read"));
});

test("navegador (F8.1): com a VM entra lazy; sem VM aparece em 'unavailable' e no log, sem sumir em silêncio", async () => {
	const withVm = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.ok(withVm.registry.ids().includes("browser"));
	assert.ok(!withVm.registry.core().some((c) => c.id === "browser"));
	assert.match(withVm.stableSystem, /- browser:/);
	const logs: string[] = [];
	const { browser: _vm, ...noVm } = base;
	const without = await buildV4Registry({ ...noVm, botId: "bot-1", deps: fakeAdapterDeps(), log: (m) => void logs.push(m) });
	assert.deepEqual(without.unavailable, ["browser", "video"]);
	assert.ok(!without.registry.ids().includes("browser"));
	assert.match(logs.join("\n"), /capacidades sem porta: browser, video/);
});

test("código (F8.2) é opt-in: sem a chave não entra nem vira 'unavailable'; plano só lê; ligado sem ambiente fica indisponível e dito", async () => {
	const off = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.ok(!off.registry.ids().includes("code"));
	assert.ok(!off.unavailable.includes("code"));
	const build = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), code: {}, codeRequested: true });
	assert.ok(build.registry.ids().includes("code"));
	assert.ok(build.registry.toolByName("code_edit"));
	const plan = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), code: { readOnly: true }, codeRequested: true });
	assert.ok(plan.registry.ids().includes("code"));
	assert.equal(plan.registry.toolByName("code_edit"), undefined);
	const logs: string[] = [];
	const noEnv = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps(), codeRequested: true, log: (m) => void logs.push(m) });
	assert.deepEqual(noEnv.unavailable, ["code"]);
	assert.match(logs.join("\n"), /capacidades sem porta: code/);
});

test("browser só lê quando não há dono presente (rotina, subagente, bot a bot), não só na agenda", async () => {
	const toolsOf = (setup: Awaited<ReturnType<typeof buildV4Registry>>) => setup.registry.capabilities.find((c) => c.id === "browser")?.tools.map((t) => t.name) ?? [];
	const attended = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.ok(toolsOf(attended).includes("browser_act"));
	const unattended = await buildV4Registry({ ...base, unattended: true, botId: "bot-1", deps: fakeAdapterDeps() });
	const names = toolsOf(unattended);
	assert.ok(names.includes("browser_open") && names.includes("browser_load_more") && names.includes("browser_digest"));
	assert.equal(names.includes("browser_act"), false);
	assert.equal(names.includes("browser_tabs"), false);
	assert.match(unattended.stableSystem, /- browser:/);
});

test("rotinas (F9): lazy no chat com as três tools; sem dono (rotina, agenda) só routine_list; sem bot a capacidade fica indisponível", async () => {
	const toolsOf = (setup: Awaited<ReturnType<typeof buildV4Registry>>) => setup.registry.capabilities.find((c) => c.id === "routines")?.tools.map((t) => t.name) ?? [];
	const attended = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.ok(!attended.registry.core().some((c) => c.id === "routines"));
	assert.match(attended.stableSystem, /- routines:/);
	assert.deepEqual(toolsOf(attended), ["routine_list", "routine_control", "routine_group"]);
	const unattended = await buildV4Registry({ ...base, unattended: true, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(unattended), ["routine_list"]);
	const agenda = await buildV4Registry({ ...base, unattended: true, agendaRun: true, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(agenda), ["routine_list"]);
	const noBot = await buildV4Registry({ ...base, deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(noBot), []);
	assert.ok(noBot.unavailable.includes("routines"));
});

test("rotinas (F9): pausar pela tool chega ao banco do dono do run, sincroniza o agendador do run e mostra o cartão", async () => {
	const synced: string[] = [];
	const live: unknown[] = [];
	const row = { id: "r1", userId: "user-a", botId: "bot-1", name: "Resumo", prompt: "x", enabled: true, triggerType: "cron", schedule: "0 8 * * *", timezone: "America/Sao_Paulo", lastRunAt: null, createdAt: "2026-11-01T00:00:00.000Z" };
	const asked: string[] = [];
	const deps = fakeAdapterDeps();
	deps.routines = {
		...deps.routines,
		persistCard: async () => undefined,
		list: (async (userId: string) => {
			asked.push(userId);
			return userId === "user-a" ? [{ ...row }] : [];
		}) as never,
		update: (async (_u: string, _b: string, _id: string, patch: { enabled: boolean }) => ({ ...row, enabled: patch.enabled })) as never,
	};
	const setup = await buildV4Registry({ ...base, botId: "bot-1", deps, emit: (event) => void live.push(event), onRoutineMutated: async (r) => void synced.push(`${r.id}:${r.enabled}`) });
	const tool = setup.registry.toolByName("routine_control")!;
	const out = await tool.run({ action: "pause", target: "Resumo" }, { runId: "run-1", ownerId: "user-a", ports: {} as never });
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.deepEqual(synced, ["r1:false"]);
	assert.deepEqual(asked.every((u) => u === "user-a"), true);
	assert.equal((live[0] as { type: string; detail: string }).detail, "Pausada");
	// outro dono não acha a rotina
	const other = await tool.run({ action: "pause", target: "Resumo" }, { runId: "run-2", ownerId: "user-b", ports: {} as never });
	assert.equal(other.ok, false);
	assert.deepEqual(synced, ["r1:false"]);
});

test("cofre (F9): lazy no chat com as três tools; sem dono (rotina, agenda) só secret_list; sem conversa não há cartão de pedido", async () => {
	const toolsOf = (setup: Awaited<ReturnType<typeof buildV4Registry>>) => setup.registry.capabilities.find((c) => c.id === "vault")?.tools.map((t) => t.name) ?? [];
	const attended = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.ok(!attended.registry.core().some((c) => c.id === "vault"));
	assert.match(attended.stableSystem, /- vault:/);
	assert.deepEqual(toolsOf(attended), ["secret_list", "secret_request", "login_fill"]);
	const unattended = await buildV4Registry({ ...base, unattended: true, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(unattended), ["secret_list"]);
	const noConversation = await buildV4Registry({ ...base, conversationId: null, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(noConversation), ["secret_list", "login_fill"]);
	const agenda = await buildV4Registry({ ...base, unattended: true, agendaRun: true, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(agenda), ["secret_list"]);
	assert.equal(attended.unavailable.includes("vault" as never), false);
});

test("github (F9, leitura): lazy com as duas tools, também sem dono; o conector GitHub fica (é por ele que se escreve) e nada é lido ao montar", async () => {
	const toolsOf = (setup: Awaited<ReturnType<typeof buildV4Registry>>) => setup.registry.capabilities.find((c) => c.id === "github")?.tools.map((t) => t.name) ?? [];
	const attended = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.ok(!attended.registry.core().some((c) => c.id === "github"));
	assert.match(attended.stableSystem, /- github:/);
	assert.deepEqual(toolsOf(attended), ["github_list_repos", "github_compare"]);
	const unattended = await buildV4Registry({ ...base, unattended: true, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(unattended), ["github_list_repos", "github_compare"]);
	const agenda = await buildV4Registry({ ...base, unattended: true, agendaRun: true, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(agenda), ["github_list_repos", "github_compare"]);
	const embedded = ({ id: "gh1", slug: "github", name: "GitHub", catalogId: "github", status: "connected", confirmWrites: true, tools: [{ name: "create_issue", inputSchema: { type: "object", properties: {} } }], disabledTools: [], toolMarks: {} }) as unknown as Connected[number];
	const withConnector = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps({ connections: [embedded] }) });
	assert.ok(withConnector.registry.toolByName("mcp_github_write"), "a escrita no GitHub continua pelo conector");
	assert.deepEqual(toolsOf(withConnector), ["github_list_repos", "github_compare"]);
	assert.equal(attended.unavailable.includes("github" as never), false);
});

test("bots (F9): lazy no chat com dono; decide_bot_pending só com 'Decidir pelos outros bots' ligado; sem dono (rotina, agenda, bot a bot) ou sem bot a capacidade nem entra", async () => {
	const toolsOf = (setup: Awaited<ReturnType<typeof buildV4Registry>>) => setup.registry.capabilities.find((c) => c.id === "bots")?.tools.map((t) => t.name);
	const attended = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.ok(!attended.registry.core().some((c) => c.id === "bots"));
	assert.match(attended.stableSystem, /- bots:/);
	assert.deepEqual(toolsOf(attended), ["list_bots", "send_to_bot", "set_primary_bot", "propose_bot"]);
	const decides = await buildV4Registry({ ...base, botId: "bot-1", deps: fakeAdapterDeps({ decideForOthers: true }) });
	assert.deepEqual(toolsOf(decides), ["list_bots", "send_to_bot", "set_primary_bot", "decide_bot_pending", "propose_bot"]);
	// Sem dono presente: nada de falar com outro bot (e o log técnico diz que faltou).
	const logs: string[] = [];
	const unattended = await buildV4Registry({ ...base, unattended: true, botId: "bot-1", deps: fakeAdapterDeps(), log: (m) => void logs.push(m) });
	assert.equal(toolsOf(unattended), undefined);
	assert.ok(unattended.unavailable.includes("bots"));
	assert.doesNotMatch(unattended.stableSystem, /- bots:/);
	const agenda = await buildV4Registry({ ...base, unattended: true, agendaRun: true, botId: "bot-1", deps: fakeAdapterDeps() });
	assert.equal(toolsOf(agenda), undefined);
	const noBot = await buildV4Registry({ ...base, deps: fakeAdapterDeps() });
	assert.equal(toolsOf(noBot), undefined);
});

test("anexos (F9): entram com a fonte e dono presente; rotina e agenda não leem a conversa", async () => {
	const source = { list: async () => [], cache: { get: async () => null } };
	const toolsOf = (setup: Awaited<ReturnType<typeof buildV4Registry>>) => setup.registry.capabilities.find((c) => c.id === "attachments")?.tools.map((t) => t.name) ?? [];
	const attended = await buildV4Registry({ ...base, attachments: source, deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(attended), ["attachment_list", "attachment_read", "attachment_to_computer"]);
	assert.ok(!attended.registry.core().some((c) => c.id === "attachments"));
	const unattended = await buildV4Registry({ ...base, unattended: true, attachments: source, deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(unattended), []);
	const agenda = await buildV4Registry({ ...base, agendaRun: true, attachments: source, deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(agenda), []);
	const noSource = await buildV4Registry({ ...base, deps: fakeAdapterDeps() });
	assert.deepEqual(toolsOf(noSource), []);
});
