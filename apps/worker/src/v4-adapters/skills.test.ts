/**
 * Habilidades do v4 no worker (F9) com db falso que filtra por dono como o real: o run só enxerga as da CONTA e as do SEU bot;
 * dono B não lê, não edita e não apaga nada de A; gravar mostra o cartão "Aprendi" (com Desfazer); o índice de nomes só traz
 * as ativas e ligadas.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/skills.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SkillDocError, type SkillDocRecord } from "@workspace/db";
import type { ComputerUseEvent } from "@workspace/shared";
import { createV4Skills, loadV4SkillNames, type V4SkillsDeps } from "./skills.js";

function doc(over: Partial<SkillDocRecord> & { id: string; name: string }): SkillDocRecord {
	return { botId: null, description: `Usar ${over.name}`, body: `1. ${over.name}`, tools: [], enabled: true, createdBy: "user", status: "active", revision: 1, source: null, createdAt: new Date(0), updatedAt: new Date(0), ...over };
}

function world() {
	const rows: Array<SkillDocRecord & { userId: string }> = [
		{ ...doc({ id: "s1", name: "relatorio" }), userId: "a" },
		{ ...doc({ id: "s2", name: "so-bot-1", botId: "bot-1" }), userId: "a" },
		{ ...doc({ id: "s3", name: "so-bot-2", botId: "bot-2" }), userId: "a" },
		{ ...doc({ id: "s4", name: "rascunho", status: "draft" }), userId: "a" },
		{ ...doc({ id: "s5", name: "desligada", enabled: false }), userId: "a" },
		{ ...doc({ id: "s6", name: "relatorio", botId: "bot-1", description: "Versão do bot", body: "1. do bot" }), userId: "a" },
		{ ...doc({ id: "sb", name: "do-b" }), userId: "b" },
	];
	const applied: unknown[] = [];
	const removed: string[] = [];
	const cards: Array<{ conversationId: string; event: ComputerUseEvent }> = [];
	const live: ComputerUseEvent[] = [];
	const strip = ({ userId: _u, ...rest }: SkillDocRecord & { userId: string }): SkillDocRecord => rest;
	const deps: V4SkillsDeps = {
		list: async (userId) => rows.filter((r) => r.userId === userId).map(strip),
		read: async (userId, name, botId) => {
			const hit = rows.find((r) => r.userId === userId && r.name === name && r.botId === (botId ?? null) && r.enabled && r.status === "active");
			return hit ? strip(hit) : null;
		},
		apply: async (userId, proposal) => {
			applied.push({ userId, ...proposal });
			if (proposal.name === "repetida") throw new SkillDocError("conflict", "Já existe uma skill com esse nome.");
			return { skillId: proposal.skillId ?? "novo", revision: (proposal.expectedRevision ?? 0) + 1 };
		},
		remove: async (userId, skillId) => {
			const index = rows.findIndex((r) => r.userId === userId && r.id === skillId);
			if (index < 0) return false;
			removed.push(skillId);
			rows.splice(index, 1);
			return true;
		},
		persistCard: async (conversationId, event) => void cards.push({ conversationId, event }),
	};
	return { deps, applied, removed, cards, live, rows };
}

const scopeOf = (w: ReturnType<typeof world>, botId: string | null = "bot-1") => ({ botId, conversationId: "conv-1", emit: (event: ComputerUseEvent) => void w.live.push(event) });

test("list: só as da conta e as do bot do run (rascunho e desligada incluídas); nunca outro bot nem outro dono", async () => {
	const w = world();
	const skills = createV4Skills({ scope: scopeOf(w), deps: w.deps });
	const names = (await skills.list("a")).map((d) => `${d.name}:${d.scope}`).sort();
	assert.deepEqual(names, ["desligada:account", "rascunho:account", "relatorio:account", "relatorio:bot", "so-bot-1:bot"]);
	assert.deepEqual(await skills.list("b").then((l) => l.map((d) => d.name)), ["do-b"]);
	assert.deepEqual(await skills.list("c"), []);
});

test("read: a do bot vence a da conta; rascunho, desligada, de outro bot e de outro dono dão null", async () => {
	const w = world();
	const skills = createV4Skills({ scope: scopeOf(w), deps: w.deps });
	assert.equal((await skills.read("a", "relatorio"))?.description, "Versão do bot");
	assert.equal((await skills.read("a", "so-bot-1"))?.scope, "bot");
	for (const name of ["rascunho", "desligada", "so-bot-2", "do-b"]) assert.equal(await skills.read("a", name), null, name);
	assert.equal(await skills.read("b", "relatorio"), null);
	const noBot = createV4Skills({ scope: scopeOf(w, null), deps: w.deps });
	assert.equal((await noBot.read("a", "relatorio"))?.description, "Usar relatorio");
	assert.equal(await noBot.read("a", "so-bot-1"), null);
});

test("save create: grava com o dono do run, escopo conta ou bot, e mostra o cartão Aprendi (ao vivo e na conversa)", async () => {
	const w = world();
	const skills = createV4Skills({ scope: scopeOf(w), deps: w.deps });
	const out = await skills.save("a", "run-1", { action: "create", name: "ata", description: "Escreve a ata", tools: ["note_write"], body: "1. Liste.", scope: "bot" });
	assert.deepEqual(out, { skillId: "novo", revision: 1 });
	assert.deepEqual(w.applied[0], { userId: "a", action: "create", name: "ata", description: "Escreve a ata", tools: ["note_write"], body: "1. Liste.", botId: "bot-1", skillId: undefined, expectedRevision: undefined });
	await skills.save("a", "run-1", { action: "create", name: "geral", description: "d", tools: [], body: "1. x", scope: "account" });
	assert.equal((w.applied[1] as { botId: unknown }).botId, null);
	const card = w.live[0] as Extract<ComputerUseEvent, { type: "skill" }>;
	assert.deepEqual(card, { type: "skill", action: "created", title: "ata", capabilityKey: "ata", versionNumber: 1, detail: "Escreve a ata", skillId: "novo", learned: true });
	assert.equal(w.cards.length, 2);
	assert.equal(w.cards[0]?.conversationId, "conv-1");
});

test("save: escopo bot sem bot no run falha; erro do db vira mensagem; edit de outro dono ou de outro bot falha sem gravar", async () => {
	const w = world();
	const noBot = createV4Skills({ scope: scopeOf(w, null), deps: w.deps });
	await assert.rejects(() => noBot.save("a", "r", { action: "create", name: "x", description: "d", tools: [], body: "1. y", scope: "bot" }), /no bot/);
	const skills = createV4Skills({ scope: scopeOf(w), deps: w.deps });
	await assert.rejects(() => skills.save("a", "r", { action: "create", name: "repetida", description: "d", tools: [], body: "1. y", scope: "account" }), /Could not save the skill: Já existe/);
	await assert.rejects(() => skills.save("b", "r", { action: "edit", name: "relatorio", description: "d", tools: [], body: "1. y", scope: "account", skillId: "s1", expectedRevision: 1 }), /não encontrada/);
	await assert.rejects(() => skills.save("a", "r", { action: "edit", name: "so-bot-2", description: "d", tools: [], body: "1. y", scope: "bot", skillId: "s3", expectedRevision: 1 }), /não encontrada/);
	assert.equal(w.applied.length, 1); // só a tentativa "repetida" chegou ao db
	assert.equal(w.live.length, 0);
});

test("save edit: usa a revisão lida e mostra o cartão 'updated' com a nova revisão", async () => {
	const w = world();
	const skills = createV4Skills({ scope: scopeOf(w), deps: w.deps });
	const out = await skills.save("a", "r", { action: "edit", name: "relatorio", description: "nova", tools: [], body: "1. novo", scope: "account", skillId: "s1", expectedRevision: 1 });
	assert.deepEqual(out, { skillId: "s1", revision: 2 });
	assert.deepEqual((w.applied[0] as { skillId: string; expectedRevision: number }).skillId, "s1");
	assert.equal((w.live[0] as { action: string }).action, "updated");
});

test("remove: apaga a visível e mostra o cartão; de outro dono ou de outro bot devolve false e nada some", async () => {
	const w = world();
	const skills = createV4Skills({ scope: scopeOf(w), deps: w.deps });
	assert.equal(await skills.remove("b", "r", "s1"), false);
	assert.equal(await skills.remove("a", "r", "s3"), false);
	assert.equal(await skills.remove("a", "r", "sb"), false);
	assert.deepEqual(w.removed, []);
	assert.equal(await skills.remove("a", "r", "s1"), true);
	assert.deepEqual(w.removed, ["s1"]);
	assert.deepEqual(w.live[0], { type: "skill", action: "deleted", title: "relatorio", capabilityKey: "relatorio" });
});

test("sem conversa o cartão só vai ao vivo; falha ao gravar o cartão não derruba a gravação", async () => {
	const w = world();
	const failing: V4SkillsDeps = { ...w.deps, persistCard: async () => { throw new Error("db fora"); } };
	const logs: string[] = [];
	const skills = createV4Skills({ scope: { ...scopeOf(w), log: (m) => void logs.push(m) }, deps: failing });
	await skills.save("a", "r", { action: "create", name: "ata", description: "d", tools: [], body: "1. x", scope: "account" });
	assert.equal(w.live.length, 1);
	assert.match(logs[0] ?? "", /não gravado na conversa/);
	const w2 = world();
	const noConversation = createV4Skills({ scope: { botId: "bot-1", emit: (e) => void w2.live.push(e) }, deps: w2.deps });
	await noConversation.save("a", "r", { action: "create", name: "ata", description: "d", tools: [], body: "1. x", scope: "account" });
	assert.equal(w2.cards.length, 0);
	assert.equal(w2.live.length, 1);
});

test("índice de nomes: só ativas e ligadas, conta + bot do run, sem repetir, ordenado; falha de leitura vira lista vazia", async () => {
	const w = world();
	assert.deepEqual(await loadV4SkillNames({ userId: "a", botId: "bot-1", deps: w.deps }), ["relatorio", "so-bot-1"]);
	assert.deepEqual(await loadV4SkillNames({ userId: "a", botId: null, deps: w.deps }), ["relatorio"]);
	assert.deepEqual(await loadV4SkillNames({ userId: "b", botId: "bot-1", deps: w.deps }), ["do-b"]);
	const logs: string[] = [];
	const names = await loadV4SkillNames({ userId: "a", deps: { list: async () => { throw new Error("db fora"); } }, log: (m) => void logs.push(m) });
	assert.deepEqual(names, []);
	assert.match(logs[0] ?? "", /índice de habilidades não carregado/);
});
