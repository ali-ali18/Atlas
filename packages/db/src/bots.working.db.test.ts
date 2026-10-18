/** `working` da lista de bots (Postgres real): run ativo acende o bot/grupo, isolamento por dono, corte de run fantasma. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { listBots } from "./bots.js";
import { prisma } from "./client.js";
import { listWorkingTargets, WORKING_RUN_STALE_MS } from "./runs.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

describe("bots.working (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherId: string;
	const ids: Record<string, string> = {};
	const conv: Record<string, string> = {};

	const mkBot = async (owner: string, name: string) => {
		const conversation = await prisma.conversation.create({ data: { userId: owner } });
		const bot = await prisma.bot.create({ data: { ownerId: owner, name, conversationId: conversation.id }, select: { id: true } });
		ids[name] = bot.id;
		conv[name] = conversation.id;
		return bot.id;
	};
	const mkRun = (owner: string, botId: string | null, conversationId: string | null, status: string, extra: Record<string, unknown> = {}) =>
		prisma.agentRun.create({ data: { userId: owner, botId, conversationId, objective: "x", status, model: "m", ...extra } });
	const workingOf = async (owner: string) => new Map((await listBots(owner)).map((b) => [b.name, b.working]));

	before(async () => {
		userId = (await createTestUser("work")).id;
		otherId = (await createTestUser("work-other")).id;
		for (const name of ["rodando", "fila", "espera", "fantasma", "ocioso", "cancelado"]) await mkBot(userId, name);
		await mkBot(otherId, "alheio");
		const groupConv = await prisma.conversation.create({ data: { userId } });
		await prisma.bot.create({ data: { ownerId: userId, name: "grupo", conversationId: groupConv.id, memberIds: [ids.rodando!] } });
		conv.grupo = groupConv.id;
		await mkRun(userId, ids.rodando!, conv.rodando!, "running");
		await mkRun(userId, ids.fila!, conv.fila!, "queued", { origin: "routine" });
		await mkRun(userId, ids.espera!, conv.espera!, "waiting_user");
		await mkRun(userId, ids.cancelado!, conv.cancelado!, "running", { cancelRequested: true });
		const ghost = await mkRun(userId, ids.fantasma!, conv.fantasma!, "running");
		await prisma.$executeRaw`UPDATE agent_runs SET "updatedAt" = now() - interval '2 hours' WHERE id = ${ghost.id}`;
		// Run de bot que delega dentro da conversa do grupo (botId de um membro, conversa do grupo).
		await mkRun(userId, ids.rodando!, conv.grupo!, "running");
		// Run de outro usuário nunca acende bot do dono.
		await mkRun(otherId, ids.alheio!, conv.alheio!, "running");
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("run queued/running acende; waiting_user, cancelado e ocioso não", async () => {
		const w = await workingOf(userId);
		assert.equal(w.get("rodando"), true);
		assert.equal(w.get("fila"), true);
		assert.equal(w.get("espera"), false);
		assert.equal(w.get("cancelado"), false);
		assert.equal(w.get("ocioso"), false);
	});

	test("run fantasma (sem sinal de vida além do corte) não deixa o bot verde", async () => {
		assert.equal((await workingOf(userId)).get("fantasma"), false);
		const now = Date.now() + WORKING_RUN_STALE_MS + 60_000;
		const later = await listWorkingTargets(userId, now);
		assert.equal(later.botIds.has(ids.rodando!), false, "tudo envelhece e some depois do corte");
	});

	test("grupo acende pela conversa do grupo", async () => {
		assert.equal((await workingOf(userId)).get("grupo"), true);
	});

	test("isolamento: o dono não vê run alheio e o outro só vê o seu", async () => {
		const mine = await listWorkingTargets(userId);
		assert.equal(mine.botIds.has(ids.alheio!), false);
		const theirs = await workingOf(otherId);
		assert.equal(theirs.get("alheio"), true);
		assert.equal(theirs.size, 1);
	});
});
