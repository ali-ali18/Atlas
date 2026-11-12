/**
 * Rotinas do v4 no worker, parte 2 (criar, editar, sugerir, veredito de alerta e push) com db falso que filtra por dono e bot como o real:
 * o gatilho vira o formato do db, o agendador e o webhook do GitHub são chamados, o cartão leva a mesma identidade `routineId`, o segredo
 * do webhook nunca aparece em evento nem no retorno, dono B não edita a rotina de A e a sugestão só nasce no bot principal com o modo
 * proativo ligado (e no modo "sugerir" nada é criado).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/routines-save.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComputerUseEvent, PersistedRoutineProposalCard, RoutineRecord, UpdateRoutineInput } from "@workspace/shared";
import { createAlertRunPort, createRoutinePush, createV4Routines, type V4RoutinesDeps } from "./routines.js";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const SECRET = "SEGREDO-DO-WEBHOOK-NUNCA-VAZA";

function row(over: Partial<RoutineRecord> & { id: string; userId: string; name: string }): RoutineRecord {
	return { botId: "bot-1", conversationId: null, groupId: null, group: null, prompt: "Confere o estoque.", model: "m", enabled: true, triggerType: "cron", schedule: "0 8 * * *", timezone: "America/Sao_Paulo", lastRunAt: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...over };
}

type CreateInput = Parameters<V4RoutinesDeps["create"]>[1];

function world(opts: { proactive?: { enabled: boolean; routineMode?: "suggest" | "auto" }; primary?: boolean } = {}) {
	const routines: RoutineRecord[] = [row({ id: "r1", userId: "a", name: "Resumo" }), row({ id: "rb", userId: "b", name: "Do B" })];
	const calls: string[] = [];
	const creates: Array<{ userId: string; input: CreateInput }> = [];
	const updates: Array<{ userId: string; id: string; patch: UpdateRoutineInput }> = [];
	const cards: Array<{ conversationId: string; event: ComputerUseEvent }> = [];
	const proposals: PersistedRoutineProposalCard[] = [];
	const events: string[] = [];
	const live: ComputerUseEvent[] = [];
	const synced: Array<{ id: string; enabled: boolean }> = [];
	const hooks: string[] = [];
	const mine = (userId: string, botId: string) => routines.filter((r) => r.userId === userId && r.botId === botId);
	let seq = 0;
	const deps = {
		list: (async (userId: string, botId: string) => mine(userId, botId).map((r) => ({ ...r }))) as V4RoutinesDeps["list"],
		create: (async (userId: string, input: CreateInput) => {
			creates.push({ userId, input });
			const generic = input.trigger?.kind === "generic";
			const created = row({
				id: `new-${++seq}`,
				userId,
				name: input.name,
				prompt: input.prompt,
				enabled: input.enabled ?? true,
				timezone: input.timezone ?? "America/Sao_Paulo",
				triggerType: input.triggerType ?? "cron",
				schedule: input.schedule ?? null,
				...(input.groupId && { groupId: input.groupId, group: { id: input.groupId, name: "Casa" } }),
				...(input.pageId && { pageId: input.pageId }),
				...(input.loginPermission && { loginPermission: { ...input.loginPermission, approvedAt: "2026-11-09T12:00:00.000Z" } }),
				...(input.trigger?.kind === "once" && { once: { runAt: input.trigger.runAt } }),
				...(input.trigger?.kind === "interval" && { interval: { everyMinutes: input.trigger.everyMinutes } }),
				...(input.trigger?.kind === "github" && { github: { repo: input.trigger.repo, events: input.trigger.events, ...(input.trigger.prNumber !== undefined && { prNumber: input.trigger.prNumber }) } as never }),
				...(generic && { hook: { hookKey: "hk_abc", url: "https://atlas.test/hooks/hk_abc" } }),
			});
			routines.push(created);
			return { routine: created, ...(generic && { hookSecret: SECRET }) };
		}) as V4RoutinesDeps["create"],
		update: (async (userId: string, botId: string, id: string, patch: UpdateRoutineInput) => {
			calls.push(`update:${userId}:${id}`);
			updates.push({ userId, id, patch });
			const found = mine(userId, botId).find((r) => r.id === id);
			if (!found) return null;
			if (patch.name !== undefined) found.name = patch.name;
			if (patch.prompt !== undefined) found.prompt = patch.prompt;
			if (patch.enabled !== undefined) found.enabled = patch.enabled;
			if (patch.timezone !== undefined) found.timezone = patch.timezone;
			if (patch.pageId !== undefined) found.pageId = patch.pageId;
			if (patch.groupId !== undefined) found.groupId = patch.groupId;
			if (patch.loginPermission === null) found.loginPermission = null;
			else if (patch.loginPermission) found.loginPermission = { ...patch.loginPermission, approvedAt: "2026-11-09T12:00:00.000Z" };
			if (patch.githubTrigger?.repo) {
				found.triggerType = "event";
				found.github = { repo: patch.githubTrigger.repo, events: patch.githubTrigger.events ?? [] } as never;
			}
			if (patch.triggerType === "interval" && patch.intervalTrigger) {
				found.triggerType = "interval";
				found.interval = patch.intervalTrigger;
				found.github = undefined;
			}
			return { ...found };
		}) as V4RoutinesDeps["update"],
		remove: (async (userId: string, botId: string, id: string) => {
			calls.push(`remove:${userId}:${id}`);
			const index = routines.findIndex((r) => r.id === id && r.userId === userId && r.botId === botId);
			if (index < 0) return false;
			routines.splice(index, 1);
			return true;
		}) as V4RoutinesDeps["remove"],
		findOrCreateGroup: (async (_userId: string, _botId: string, name: string) => ({ group: { id: `g-${name}`, name }, created: true })) as unknown as V4RoutinesDeps["findOrCreateGroup"],
		convertToWebhook: (async (userId: string, botId: string, id: string) => {
			calls.push(`convert:${userId}:${id}`);
			const found = mine(userId, botId).find((r) => r.id === id);
			if (!found) return null;
			Object.assign(found, { triggerType: "event", schedule: null, hook: { hookKey: "hk_conv", url: "https://atlas.test/hooks/hk_conv" } });
			return { routine: { ...found }, hookSecret: SECRET };
		}) as V4RoutinesDeps["convertToWebhook"],
		hookUrl: (key: string) => `https://atlas.test/hooks/${key}`,
		listWebhooks: (async (userId: string) => (userId === "a" ? [{ routineId: "w1", botId: "bot-1", name: "Entrada", enabled: true, hookKey: "hk_w1", secretEnc: "ENC" }, { routineId: "w2", botId: "bot-2", name: "Outro bot", enabled: true, hookKey: "hk_w2", secretEnc: null }] : [])) as V4RoutinesDeps["listWebhooks"],
		listBots: (async (userId: string) => (userId === "a" ? [{ id: "bot-1", isPrimary: opts.primary !== false }] : [{ id: "bot-b", isPrimary: true }])) as unknown as V4RoutinesDeps["listBots"],
		getBotPolicy: (async () => ({ proactive: { enabled: opts.proactive?.enabled ?? false, routineMode: opts.proactive?.routineMode ?? "suggest" } })) as V4RoutinesDeps["getBotPolicy"],
		getBotConversationId: (async () => "conv-1") as V4RoutinesDeps["getBotConversationId"],
		findRecentProposalByName: (async (_conversationId: string, name: string) => proposals.find((p) => p.spec.name === name) ?? null) as V4RoutinesDeps["findRecentProposalByName"],
		createFromProposal: (async (userId: string, botId: string, spec: { name: string; prompt: string; timezone: string; schedule?: string }) => {
			const created = row({ id: `auto-${++seq}`, userId, botId, name: spec.name, prompt: spec.prompt, schedule: spec.schedule ?? null });
			routines.push(created);
			return { routine: created };
		}) as unknown as V4RoutinesDeps["createFromProposal"],
		appendProposalCard: (async (_conversationId: string, card: PersistedRoutineProposalCard) => {
			proposals.push(card);
			return "msg-1";
		}) as V4RoutinesDeps["appendProposalCard"],
		recordEvent: (async (input: { kind: string; detail?: string }) => {
			events.push(`${input.kind}:${input.detail}`);
		}) as V4RoutinesDeps["recordEvent"],
		randomId: () => "abcd1234",
		persistCard: async (conversationId: string, event: ComputerUseEvent) => {
			cards.push({ conversationId, event });
		},
		now: () => NOW,
	} as unknown as V4RoutinesDeps;
	const port = (o: { withHook?: boolean; hookResult?: unknown; failSync?: boolean } = {}) =>
		createV4Routines({
			scope: {
				botId: "bot-1",
				conversationId: "conv-1",
				emit: (event) => {
					live.push(event);
				},
				onMutated: async (r) => {
					if (o.failSync) throw new Error("queue down");
					synced.push({ id: r.id, enabled: r.enabled });
				},
				...(o.withHook && {
					ensureGithubHook: async (_userId: string, repo: string) => {
						hooks.push(repo);
						return o.hookResult ?? { ok: true };
					},
				}),
				log: () => undefined,
			},
			deps,
		});
	return { routines, calls, creates, updates, cards, proposals, events, live, synced, hooks, port };
}

const baseCreate = { name: "Alerta de estoque", task: "Confere o estoque da canela.", timezone: "America/Sao_Paulo", enabled: true } as const;

test("criar cron: grava com o dono e o bot do run, sincroniza o agendador, grava e mostra o cartão 'created' com o routineId da rotina nova", async () => {
	const w = world();
	const saved = await w.port().create("a", { ...baseCreate, trigger: { kind: "cron", schedule: "0 9 * * 1-5" }, notify: "important", group: "Casa", panelId: "p1" });
	assert.equal(w.creates.length, 1);
	assert.equal(w.creates[0]!.userId, "a");
	assert.deepEqual({ ...w.creates[0]!.input, groupId: undefined }, { botId: "bot-1", name: "Alerta de estoque", prompt: "Confere o estoque da canela.", enabled: true, timezone: "America/Sao_Paulo", groupId: undefined, pageId: "p1", notify: "important", triggerType: "cron", schedule: "0 9 * * 1-5" });
	assert.equal(w.creates[0]!.input.groupId, "g-Casa");
	assert.deepEqual(w.synced, [{ id: saved.routine.id, enabled: true }]);
	const card = w.live[0] as { action: string; routineId: string };
	assert.equal(card.action, "created");
	assert.equal(card.routineId, saved.routine.id);
	assert.deepEqual(w.cards.map((c) => (c.event as { routineId?: string }).routineId), [saved.routine.id]);
	assert.equal(saved.routine.panelId, "p1");
	assert.equal(saved.routine.group, "Casa");
});

test("criar uma vez e intervalo: o gatilho vai no formato do db", async () => {
	const w = world();
	await w.port().create("a", { ...baseCreate, name: "Aluguel", trigger: { kind: "once", runAt: "2026-12-03T13:00:00.000Z" } });
	await w.port().create("a", { ...baseCreate, name: "PR", trigger: { kind: "interval", everyMinutes: 180 } });
	assert.deepEqual(w.creates[0]!.input.trigger, { kind: "once", runAt: "2026-12-03T13:00:00.000Z" });
	assert.equal(w.creates[0]!.input.triggerType, "once");
	assert.deepEqual(w.creates[1]!.input.trigger, { kind: "interval", everyMinutes: 180 });
});

test("criar com alerta e com permissão de login: o db recebe o alerta e o login+site aprovados", async () => {
	const w = world();
	const saved = await w.port().create("a", { ...baseCreate, trigger: { kind: "cron", schedule: "0 10,14 * * 1-5" }, alert: { condition: "o estoque cair abaixo de 10", hint: "planilha" }, loginAccess: { login: "banco", site: "banco.example" } });
	assert.deepEqual(w.creates[0]!.input.alert, { condition: "o estoque cair abaixo de 10", hint: "planilha" });
	assert.deepEqual(w.creates[0]!.input.loginPermission, { login: "banco", site: "banco.example" });
	assert.deepEqual(saved.routine.loginAccess, { login: "banco", site: "banco.example" });
});

test("criar webhook: o segredo NUNCA aparece no retorno, no evento ao vivo nem no cartão gravado; só o endereço", async () => {
	const w = world();
	const saved = await w.port().create("a", { ...baseCreate, trigger: { kind: "webhook" } });
	assert.deepEqual(saved.webhook, { url: "https://atlas.test/hooks/hk_abc" });
	const everything = JSON.stringify({ saved, live: w.live, cards: w.cards });
	assert.ok(!everything.includes(SECRET));
	assert.ok(!everything.includes("hookSecret"));
	assert.equal((w.live[0] as { hookUrl?: string }).hookUrl, "https://atlas.test/hooks/hk_abc");
});

test("criar GitHub: liga o webhook do repositório; se não liga, a rotina é desfeita e o erro traz o motivo real", async () => {
	const ok = world();
	await ok.port({ withHook: true }).create("a", { ...baseCreate, trigger: { kind: "github", repo: "acme/site", events: ["push"] } });
	assert.deepEqual(ok.hooks, ["acme/site"]);
	assert.equal(ok.routines.filter((r) => r.userId === "a").length, 2);

	const bad = world();
	await assert.rejects(() => bad.port({ withHook: true, hookResult: { error: "GitHub não conectado" } }).create("a", { ...baseCreate, trigger: { kind: "github", repo: "acme/site", events: ["push"] } }), /GitHub não conectado/);
	assert.equal(bad.routines.some((r) => r.name === "Alerta de estoque"), false);
	assert.equal(bad.live.length, 0);
	assert.deepEqual(bad.synced.at(-1)?.enabled, false);

	const none = world();
	await assert.rejects(() => none.port().create("a", { ...baseCreate, trigger: { kind: "github", repo: "acme/site", events: ["push"] } }), /not available in this run/);
	assert.equal(none.creates.length, 0);
});

test("erro do db (caixa de e-mail ausente) chega com a dica do que o dono faz; nada é gravado nem mostrado", async () => {
	const w = world();
	const failing = createV4Routines({ scope: { botId: "bot-1", emit: () => undefined, log: () => undefined }, deps: { ...({} as V4RoutinesDeps), create: async () => { throw new Error("Este bot ainda não tem e-mail próprio: ative na aba E-mail do bot antes de criar um gatilho de e-mail"); }, findOrCreateGroup: undefined as never, list: async () => [], now: () => NOW } });
	await assert.rejects(() => failing.create("a", { ...baseCreate, trigger: { kind: "email" } }), /E-mail tab/);
	assert.equal(w.live.length, 0);
});

test("editar: B não edita a rotina de A (null, nenhuma escrita, agendador e cartão intocados); outro bot também não", async () => {
	const w = world();
	assert.equal(await w.port().update("b", "r1", { name: "Hackeada" }), null);
	assert.equal(w.updates.length, 0);
	assert.deepEqual(w.synced, []);
	assert.deepEqual(w.live, []);
	assert.equal(w.routines.find((r) => r.id === "r1")?.name, "Resumo");
});

test("editar: nome, instrução, painel (vazio desliga), grupo (vazio tira), login (null tira); sincroniza e atualiza o cartão com o MESMO routineId (sem gravar)", async () => {
	const w = world();
	const saved = await w.port().update("a", "r1", { name: "Resumo novo", task: "Outra instrução.", panelId: "p9", group: "Casa", loginAccess: { login: "banco", site: "banco.example" } });
	assert.deepEqual(w.updates[0]!.patch, { name: "Resumo novo", prompt: "Outra instrução.", pageId: "p9", groupId: "g-Casa", loginPermission: { login: "banco", site: "banco.example" } });
	assert.equal(saved?.routine.loginAccess?.site, "banco.example");
	assert.deepEqual(w.synced, [{ id: "r1", enabled: true }]);
	assert.equal((w.live[0] as { routineId: string; action: string }).routineId, "r1");
	assert.equal((w.live[0] as { action: string }).action, "updated");
	assert.deepEqual(w.cards, []);
	await w.port().update("a", "r1", { panelId: "", group: "", loginAccess: null });
	assert.deepEqual(w.updates[1]!.patch, { pageId: null, groupId: null, loginPermission: null });
});

test("editar o gatilho: intervalo vai como intervalTrigger; GitHub liga o hook novo e, saindo do repositório antigo, o encolhe", async () => {
	const w = world();
	w.routines.push(row({ id: "g1", userId: "a", name: "PR", triggerType: "event", schedule: null, github: { repo: "acme/velho", events: ["push"] } as never }));
	const port = w.port({ withHook: true });
	await port.update("a", "g1", { trigger: { kind: "interval", everyMinutes: 240 } });
	assert.deepEqual(w.updates[0]!.patch, { triggerType: "interval", intervalTrigger: { everyMinutes: 240 } });
	assert.deepEqual(w.hooks, ["acme/velho"]);
	w.routines.push(row({ id: "g2", userId: "a", name: "PR2", triggerType: "event", schedule: null, github: { repo: "acme/velho", events: ["push"] } as never }));
	await port.update("a", "g2", { trigger: { kind: "github", repo: "acme/novo", events: ["pr_opened"] } });
	assert.deepEqual(w.hooks, ["acme/velho", "acme/novo", "acme/velho"]);
});

test("editar o gatilho para GitHub sem o hook ligar: volta ao gatilho anterior e diz o motivo", async () => {
	const w = world();
	await assert.rejects(() => w.port({ withHook: true, hookResult: { error: "sem acesso ao repositório" } }).update("a", "r1", { trigger: { kind: "github", repo: "acme/site", events: ["push"] } }), /sem acesso ao repositório.*previous trigger was kept/);
	assert.deepEqual(w.updates.at(-1)?.patch, { triggerType: "cron", schedule: "0 8 * * *" });
});

test("editar para webhook: converte uma vez (segredo só no db); quem já é webhook não é trocado", async () => {
	const w = world();
	const saved = await w.port().update("a", "r1", { trigger: { kind: "webhook" } });
	assert.ok(w.calls.includes("convert:a:r1"));
	assert.equal(saved?.webhook?.url, "https://atlas.test/hooks/hk_conv");
	assert.ok(!JSON.stringify({ saved, live: w.live }).includes(SECRET));
	const again = await w.port().update("a", "r1", { trigger: { kind: "webhook" } });
	assert.equal(w.calls.filter((c) => c === "convert:a:r1").length, 1);
	assert.equal(again?.webhook?.url, "https://atlas.test/hooks/hk_conv");
});

test("webhooks: só os do dono e deste bot, sem segredo", async () => {
	const w = world();
	assert.deepEqual(await w.port().webhooks("a"), [{ routineId: "w1", name: "Entrada", enabled: true, url: "https://atlas.test/hooks/hk_w1" }]);
	assert.deepEqual(await w.port().webhooks("b"), []);
});

const spec = { name: "Resumo da semana", task: "Resumir as vendas da semana.", trigger: { kind: "cron", schedule: "0 8 * * 1" } } as const;

test("sugerir (modo sugerir): grava o cartão pendente, registra o evento e NÃO cria rotina", async () => {
	const w = world({ proactive: { enabled: true, routineMode: "suggest" } });
	const before = w.routines.length;
	assert.deepEqual(await w.port().suggest("a", spec, { runId: "run-1" }), { status: "proposed" });
	assert.equal(w.routines.length, before);
	assert.equal(w.proposals.length, 1);
	assert.equal(w.proposals[0]!.status, "pending");
	assert.equal(w.proposals[0]!.mode, "suggest");
	assert.deepEqual(w.events, ["routine:suggest"]);
	assert.deepEqual(w.synced, []);
});

test("sugerir (modo automático): cria, sincroniza e o cartão guarda o id para 'Desfazer'", async () => {
	const w = world({ proactive: { enabled: true, routineMode: "auto" } });
	assert.deepEqual(await w.port().suggest("a", spec, { runId: "run-1" }), { status: "created" });
	assert.equal(w.synced.length, 1);
	assert.equal(w.proposals[0]!.routineId, w.synced[0]!.id);
});

test("sugerir: modo proativo desligado, bot que não é o principal ou o mesmo nome de novo recusam com o motivo", async () => {
	await assert.rejects(() => world({ proactive: { enabled: false } }).port().suggest("a", spec, { runId: "r" }), /Proactive mode is off/);
	await assert.rejects(() => world({ proactive: { enabled: true }, primary: false }).port().suggest("a", spec, { runId: "r" }), /main bot/);
	await assert.rejects(() => world({ proactive: { enabled: true } }).port().suggest("b", spec, { runId: "r" }), /main bot/);
	const w = world({ proactive: { enabled: true } });
	await w.port().suggest("a", spec, { runId: "r" });
	assert.deepEqual(await w.port().suggest("a", spec, { runId: "r" }), { status: "already_proposed", proposal: "pending" });
	assert.deepEqual(await w.port().suggest("a", { ...spec, name: "Resumo", task: "Confere o estoque.", trigger: { kind: "cron", schedule: "0 8 * * *" } }, { runId: "r" }), { status: "duplicate_routine", routine: "Resumo" });
});

test("veredito do alerta: um por run, o objeto do run recebe o valor", () => {
	const report: { verdict: { triggered: boolean; summary: string } | null } = { verdict: null };
	const port = createAlertRunPort(report);
	assert.equal(port.record({ triggered: true, summary: "Estoque: 7 un." }), "recorded");
	assert.equal(port.record({ triggered: false, summary: "outro" }), "already_reported");
	assert.deepEqual(report.verdict, { triggered: true, summary: "Estoque: 7 un." });
});

test("push da rotina 'só importante': um por run; no horário de silêncio não envia", async () => {
	const sent: string[] = [];
	const push = createRoutinePush({ send: async (text) => void sent.push(text) });
	assert.deepEqual(await push.send("Estoque baixo"), { sent: true });
	assert.deepEqual(await push.send("de novo"), { sent: false, reason: "one_per_run" });
	assert.deepEqual(sent, ["Estoque baixo"]);
	const quiet = createRoutinePush({ send: async (text) => void sent.push(text), quiet: { enabled: true, timezone: "UTC", quietStart: "00:00", quietEnd: "23:59" } as never, now: () => NOW });
	assert.deepEqual(await quiet.send("de madrugada"), { sent: false, reason: "quiet_hours" });
	assert.deepEqual(sent, ["Estoque baixo"]);
});

test("agendador que falha: a rotina fica salva, mas criar e editar devolvem notScheduled (o modelo não diz 'criada e rodando')", async () => {
	const w = world();
	const created = await w.port({ failSync: true }).create("a", { ...baseCreate, trigger: { kind: "cron", schedule: "0 9 * * 1-5" } });
	assert.equal(created.notScheduled, true);
	assert.equal(w.creates.length, 1, "a rotina foi gravada");
	const updated = await w.port({ failSync: true }).update("a", created.routine.id, { name: "Novo nome" });
	assert.equal(updated?.notScheduled, true);
	const fine = await w.port().create("a", { ...baseCreate, name: "Outra", trigger: { kind: "cron", schedule: "0 10 * * 1-5" } });
	assert.equal(fine.notScheduled, undefined);
});
