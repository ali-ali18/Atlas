import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "@workspace/db";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { maybeHandleConfirmedAction } = await import("./confirmed-action.js");

const base = { userId: "user-a", botId: "bot-a", conversationId: "c1", model: "m" };

test("pedido de skill em texto não é interceptado: segue para o agente (sem run nem efeito)", async () => {
	const original = { pending: prisma.skillPendingIntent.findUnique, createRun: prisma.agentRun.create };
	let runsCreated = 0;
	prisma.skillPendingIntent.findUnique = (async () => null) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.agentRun.create = (async () => {
		runsCreated += 1;
		return {};
	}) as unknown as typeof prisma.agentRun.create;
	try {
		for (const text of [
			"cria uma skill para relatório semanal",
			"apaga a skill relatorio",
			"lista minhas skills",
			"edita a skill relatorio: adiciona um passo",
		]) {
			const result = await maybeHandleConfirmedAction({ ...base, text });
			assert.deepEqual(result, { handled: false }, text);
		}
		assert.equal(runsCreated, 0);
	} finally {
		prisma.skillPendingIntent.findUnique = original.pending;
		prisma.agentRun.create = original.createRun;
	}
});
