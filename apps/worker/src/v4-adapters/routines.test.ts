/**
 * Rotinas do v4 no worker (F9, parte 1) com db falso que filtra por dono e bot como o real: a lista traz o gatilho em frase e
 * a próxima execução só quando se sabe; pausar/retomar/apagar sincronizam o agendador e mostram o cartão; dono B não enxerga
 * nem muda nada de A; grupos seguem o mesmo escopo.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/routines.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComputerUseEvent, RoutineGroupRecord, RoutineRecord } from "@workspace/shared";
import { createV4Routines, toRoutineView, type V4RoutinesDeps } from "./routines.js";

const NOW = new Date("2026-11-09T12:00:00.000Z");

function routine(over: Partial<RoutineRecord> & { id: string; userId: string; name: string }): RoutineRecord {
	return {
		botId: "bot-1",
		conversationId: null,
		groupId: null,
		group: null,
		prompt: "Faz   a conferência\n do estoque.",
		model: "m",
		enabled: true,
		triggerType: "cron",
		schedule: "0 8 * * *",
		timezone: "America/Sao_Paulo",
		lastRunAt: null,
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-01T00:00:00.000Z",
		...over,
	};
}

function world() {
	const routines: RoutineRecord[] = [
		routine({ id: "r1", userId: "a", name: "Resumo da manhã" }),
		routine({ id: "r2", userId: "a", name: "Aluguel", triggerType: "once", schedule: null, once: { runAt: "2026-12-03T13:00:00.000Z" }, groupId: "g1", group: { id: "g1", name: "Casa" } }),
		routine({ id: "r3", userId: "a", name: "Pausada", enabled: false, groupId: "g1", group: { id: "g1", name: "Casa" } }),
		routine({ id: "r4", userId: "a", name: "De outro bot", botId: "bot-2" }),
		routine({ id: "rb", userId: "b", name: "Rotina do B" }),
	];
	const groups: Array<RoutineGroupRecord & { userId: string }> = [
		{ id: "g1", userId: "a", botId: "bot-1", name: "Casa", description: "", createdAt: "", updatedAt: "", routineCount: 2, enabledCount: 1 },
		{ id: "gb", userId: "b", botId: "bot-1", name: "Do B", description: "", createdAt: "", updatedAt: "", routineCount: 0, enabledCount: 0 },
	];
	const calls: string[] = [];
	const cards: Array<{ conversationId: string; event: ComputerUseEvent }> = [];
	const live: ComputerUseEvent[] = [];
	const synced: Array<{ id: string; enabled: boolean }> = [];
	const mine = (userId: string, botId: string) => routines.filter((r) => r.userId === userId && r.botId === botId);
	const deps: V4RoutinesDeps = {
		list: (async (userId: string, botId: string) => {
			calls.push(`list:${userId}`);
			// Cópias, como o db: o que foi lido antes de escrever não muda junto.
			return mine(userId, botId).map((r) => ({ ...r }));
		}) as V4RoutinesDeps["list"],
		update: (async (userId: string, botId: string, id: string, patch: { enabled?: boolean; groupId?: string | null }) => {
			calls.push(`update:${userId}:${id}`);
			const row = mine(userId, botId).find((r) => r.id === id);
			if (!row) return null;
			if (patch.enabled !== undefined) row.enabled = patch.enabled;
			if (patch.groupId !== undefined) {
				const group = groups.find((g) => g.id === patch.groupId && g.userId === userId);
				row.groupId = patch.groupId;
				row.group = group ? { id: group.id, name: group.name } : null;
			}
			return row;
		}) as V4RoutinesDeps["update"],
		remove: (async (userId: string, botId: string, id: string) => {
			calls.push(`remove:${userId}:${id}`);
			const index = routines.findIndex((r) => r.id === id && r.userId === userId && r.botId === botId);
			if (index < 0) return false;
			routines.splice(index, 1);
			return true;
		}) as V4RoutinesDeps["remove"],
		listGroups: (async (userId: string, botId: string) => groups.filter((g) => g.userId === userId && g.botId === botId)) as V4RoutinesDeps["listGroups"],
		createGroup: (async (userId: string, botId: string, input: { name: string }) => {
			const group = { id: `g${groups.length + 1}`, userId, botId, name: input.name, description: "", createdAt: "", updatedAt: "", routineCount: 0, enabledCount: 0 };
			groups.push(group);
			return group;
		}) as V4RoutinesDeps["createGroup"],
		updateGroup: (async (userId: string, _botId: string, id: string, input: { name?: string }) => {
			calls.push(`updateGroup:${userId}:${id}`);
			const group = groups.find((g) => g.id === id && g.userId === userId);
			if (!group) return null;
			if (input.name) group.name = input.name;
			return group;
		}) as V4RoutinesDeps["updateGroup"],
		deleteGroup: (async (userId: string, botId: string, id: string) => {
			calls.push(`deleteGroup:${userId}:${id}`);
			const index = groups.findIndex((g) => g.id === id && g.userId === userId);
			if (index < 0) return null;
			groups.splice(index, 1);
			return { routines: mine(userId, botId).filter((r) => r.groupId === id), deletedRoutines: false };
		}) as V4RoutinesDeps["deleteGroup"],
		setGroupEnabled: (async (userId: string, botId: string, id: string, enabled: boolean) => {
			calls.push(`setGroupEnabled:${userId}:${id}`);
			if (!groups.some((g) => g.id === id && g.userId === userId)) return null;
			const inside = mine(userId, botId).filter((r) => r.groupId === id);
			for (const r of inside) r.enabled = enabled;
			return inside;
		}) as V4RoutinesDeps["setGroupEnabled"],
		persistCard: async (conversationId, event) => {
			cards.push({ conversationId, event });
		},
		now: () => NOW,
	};
	const hooks: Array<{ userId: string; repo: string }> = [];
	const port = (opts: { conversationId?: string | null; syncFails?: boolean; withHook?: boolean; hookFails?: boolean } = {}) =>
		createV4Routines({
			scope: {
				botId: "bot-1",
				conversationId: opts.conversationId === undefined ? "conv-1" : opts.conversationId,
				emit: (event) => {
					live.push(event);
				},
				onMutated: async (r) => {
					if (opts.syncFails) throw new Error("redis fora");
					synced.push({ id: r.id, enabled: r.enabled });
				},
				...(opts.withHook && {
					ensureGithubHook: async (userId: string, repo: string) => {
						if (opts.hookFails) throw new Error("github fora");
						hooks.push({ userId, repo });
					},
				}),
				log: () => undefined,
			},
			deps,
		});
	return { routines, groups, calls, cards, live, synced, hooks, port };
}

test("lista: só as rotinas do dono neste bot, com gatilho em frase, grupo, instrução numa linha e próxima execução quando se sabe", async () => {
	const w = world();
	const list = await w.port().list("a");
	assert.deepEqual(list.map((r) => r.id), ["r1", "r2", "r3"]);
	assert.deepEqual(list[0], { id: "r1", name: "Resumo da manhã", trigger: "todo dia às 8h", kind: "cron", enabled: true, task: "Faz a conferência do estoque." });
	assert.deepEqual(list[1], { id: "r2", name: "Aluguel", trigger: "Uma vez · 03/12 às 10:00", kind: "once", enabled: true, group: "Casa", task: "Faz a conferência do estoque.", nextRunAt: "2026-12-03T13:00:00.000Z" });
	assert.equal(list[2]?.enabled, false);
	assert.ok(!JSON.stringify(list).includes("userId"));
});

test("o gatilho do webhook não mostra a chave interna e instrução longa é cortada", () => {
	const view = toRoutineView(routine({ id: "x", userId: "a", name: "W", triggerType: "event", schedule: null, hook: { hookKey: "hk_interna", url: "https://x" }, prompt: "a".repeat(500) }), NOW);
	assert.equal(view.trigger, "webhook");
	assert.equal(view.task.length, 280);
	assert.ok(view.task.endsWith("…"));
});

test("dono B só lista as dele; as de A (e as de outro bot) não aparecem", async () => {
	const list = await world().port().list("b");
	assert.deepEqual(list.map((r) => r.id), ["rb"]);
});

test("pausar: muda no banco com o dono do run, sincroniza o agendador e grava + mostra o cartão 'Pausada'", async () => {
	const w = world();
	const view = await w.port().setEnabled("a", "r1", false);
	assert.equal(view?.enabled, false);
	assert.deepEqual(w.synced, [{ id: "r1", enabled: false }]);
	const expected = { type: "routine", action: "updated", routineId: "r1", title: "Resumo da manhã", triggerType: "cron", detail: "Pausada" };
	assert.deepEqual(w.live, [expected]);
	assert.deepEqual(w.cards, [{ conversationId: "conv-1", event: expected }]);
	await w.port().setEnabled("a", "r1", true);
	assert.deepEqual(w.synced.at(-1), { id: "r1", enabled: true });
	assert.equal((w.live.at(-1) as { detail: string }).detail, "Retomada");
});

test("apagar: some do banco, o agendador recebe a rotina desligada e o cartão diz 'Apagada' sem id", async () => {
	const w = world();
	const view = await w.port().remove("a", "r2");
	assert.equal(view?.name, "Aluguel");
	assert.equal(w.routines.some((r) => r.id === "r2"), false);
	assert.deepEqual(w.synced, [{ id: "r2", enabled: false }]);
	const card = w.live[0] as { routineId?: string; detail: string };
	assert.equal(card.routineId, undefined);
	assert.match(card.detail, /^Apagada\n/);
	assert.equal(w.cards.length, 1);
});

test("dono B não pausa, retoma nem apaga a rotina de A: null, nenhuma escrita no banco, nenhum cartão, agendador intocado", async () => {
	const w = world();
	const port = w.port();
	assert.equal(await port.setEnabled("b", "r1", false), null);
	assert.equal(await port.remove("b", "r1"), null);
	assert.equal(await port.moveToGroup("b", "r1", "gb"), null);
	assert.equal(w.routines.find((r) => r.id === "r1")?.enabled, true);
	assert.equal(w.calls.some((c) => c.startsWith("update:") || c.startsWith("remove:")), false);
	assert.deepEqual(w.live, []);
	assert.deepEqual(w.cards, []);
	assert.deepEqual(w.synced, []);
});

test("rotina de outro bot do mesmo dono também é 'não existe' neste run", async () => {
	const w = world();
	assert.equal(await w.port().setEnabled("a", "r4", false), null);
	assert.equal(await w.port().remove("a", "r4"), null);
});

test("falha do agendador não desfaz nem esconde a mudança (melhor esforço); sem conversa o cartão só aparece ao vivo", async () => {
	const w = world();
	const view = await w.port({ syncFails: true, conversationId: null }).setEnabled("a", "r1", false);
	assert.equal(view?.enabled, false);
	assert.equal(w.live.length, 1);
	assert.deepEqual(w.cards, []);
});

test("falha ao apagar de verdade lança com o motivo (nunca sucesso falso)", async () => {
	const w = world();
	const failing = createV4Routines({ scope: { botId: "bot-1", emit: () => undefined, log: () => undefined }, deps: { ...({} as V4RoutinesDeps), list: async () => w.routines.filter((r) => r.userId === "a" && r.botId === "bot-1"), remove: async () => false, now: () => NOW } });
	await assert.rejects(() => failing.remove("a", "r1"), /could not be deleted/);
});

test("grupos: só os do dono; criar e renomear; B não renomeia nem desfaz o de A", async () => {
	const w = world();
	const port = w.port();
	assert.deepEqual((await port.groups("a")).map((g) => g.name), ["Casa"]);
	assert.deepEqual((await port.groups("b")).map((g) => g.name), ["Do B"]);
	assert.equal((await port.createGroup("a", "Trabalho")).name, "Trabalho");
	assert.equal((await port.renameGroup("a", "g1", "Minha casa"))?.name, "Minha casa");
	assert.equal(await port.renameGroup("b", "g1", "Hackeado"), null);
	assert.equal(await port.deleteGroup("b", "g1"), null);
	assert.equal(await port.setGroupEnabled("b", "g1", false), null);
	assert.equal(w.groups.find((g) => g.id === "g1")?.name, "Minha casa");
	assert.equal(w.calls.some((c) => c === "deleteGroup:b:g1" || c === "updateGroup:b:g1" || c === "setGroupEnabled:b:g1"), false);
});

test("pausar o grupo: conta só as que mudaram, sincroniza cada uma e mostra um cartão ao vivo (sem gravar)", async () => {
	const w = world();
	const result = await w.port().setGroupEnabled("a", "g1", false);
	assert.deepEqual(result, { name: "Casa", total: 2, changed: 1 });
	assert.deepEqual(w.synced.map((s) => s.id).sort(), ["r2", "r3"]);
	assert.equal(w.live.length, 1);
	assert.deepEqual(w.cards, []);
});

test("desfazer o grupo: as rotinas ficam; mover e tirar do grupo usam o dono do run e conferem o grupo", async () => {
	const w = world();
	const port = w.port();
	assert.deepEqual(await port.deleteGroup("a", "g1"), { name: "Casa", routines: 2 });
	const moved = await port.moveToGroup("a", "r1", "g3");
	assert.equal(moved, null);
	const created = await port.createGroup("a", "Novo");
	const into = await port.moveToGroup("a", "r1", created.id);
	assert.equal(into?.group, "Novo");
	const out = await port.moveToGroup("a", "r1", null);
	assert.equal(out?.group, undefined);
	assert.equal(await port.moveToGroup("a", "r1", "gb"), null); // grupo do B
});

const ghTrigger = (repo: string) => ({ kind: "github", repo, events: ["push"] });

test("P2: retomar um grupo com rotinas de GitHub reconcilia o webhook uma vez por repositório (e só as de GitHub)", async () => {
	const w = world();
	for (const id of ["g-a", "g-b", "g-c"]) {
		w.routines.push(routine({ id, userId: "a", name: id, groupId: "g1", group: { id: "g1", name: "Casa" }, enabled: false, triggerType: "event", schedule: null, triggerJson: ghTrigger(id === "g-c" ? "acme/outro" : "acme/site") }));
	}
	await w.port({ withHook: true }).setGroupEnabled("a", "g1", true);
	assert.deepEqual(w.hooks.map((h) => h.repo).sort(), ["acme/outro", "acme/site"]);
	assert.ok(w.hooks.every((h) => h.userId === "a"));
});

test("P2: pausar e apagar rotina de GitHub reconciliam o webhook; rotina comum não", async () => {
	const w = world();
	w.routines.push(routine({ id: "g1x", userId: "a", name: "PR", triggerType: "event", schedule: null, triggerJson: ghTrigger("acme/site") }));
	const port = w.port({ withHook: true });
	await port.setEnabled("a", "g1x", false);
	await port.remove("a", "g1x");
	assert.deepEqual(w.hooks, [{ userId: "a", repo: "acme/site" }, { userId: "a", repo: "acme/site" }]);
	await port.setEnabled("a", "r1", false);
	assert.equal(w.hooks.length, 2);
});

test("P2: falha ao sincronizar o webhook não desfaz a mudança", async () => {
	const w = world();
	w.routines.push(routine({ id: "g1x", userId: "a", name: "PR", triggerType: "event", schedule: null, triggerJson: ghTrigger("acme/site") }));
	const result = await w.port({ withHook: true, hookFails: true }).setEnabled("a", "g1x", false);
	assert.equal(result?.enabled, false);
});
