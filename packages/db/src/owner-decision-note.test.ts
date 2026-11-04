import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNER_DECISION_ROLE } from "@workspace/shared";
import { prisma } from "./client.js";
import { lastConversationMessages } from "./bots.js";
import { appendOwnerDecisionNote, listConversationMessages, loadMessagesAfterWatermark, loadRecentConversationMessages } from "./conversations.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

/**
 * Auditoria do PR #131: a nota da recusa gravada como `system` sumia do histórico do v3, subia para o início no
 * v1/v2 (regra permanente), aparecia na prévia e na busca. Agora é um role próprio e oculto (`owner_decision`).
 */
const at = (s: number) => new Date(Date.UTC(2026, 10, 4, 12, 0, s));
const NOTE = 'Owner declined: "Enviar esta mensagem". It was not done.';

function seeded() {
	const messages = new FakeTable([
		{ id: "m1", conversationId: "c1", role: "user", content: "Manda o resumo para a Ana", origin: null, createdAt: at(1) },
		{ id: "m2", conversationId: "c1", role: "confirm", content: "{}", origin: null, createdAt: at(2) },
		{ id: "m3", conversationId: "c1", role: "user", content: "cancela isso", origin: null, createdAt: at(3) },
		{ id: "m4", conversationId: "c1", role: OWNER_DECISION_ROLE, content: NOTE, origin: null, createdAt: at(4) },
		{ id: "m5", conversationId: "c1", role: "user", content: "e o painel?", origin: null, createdAt: at(5) },
	], () => ({ id: `m${Math.random()}`, createdAt: new Date(), origin: null }));
	return messages;
}

test("só o dono grava a nota, com role oculto e o texto sem prefixo", async () => {
	const messages = new FakeTable([], () => ({ id: "n1", createdAt: new Date() }));
	const installed = installFakes({ conversationMessage: messages, conversation: new FakeTable([{ id: "c1", userId: "user-a" }]) });
	try {
		assert.equal(await appendOwnerDecisionNote({ conversationId: "c1", ownerId: "user-b", content: NOTE }), false);
		assert.equal(messages.rows.length, 0, "usuário B não grava na conversa do usuário A");
		assert.equal(await appendOwnerDecisionNote({ conversationId: "c1", ownerId: "user-a", content: NOTE }), true);
		assert.equal(messages.rows[0]?.role, OWNER_DECISION_ROLE);
		assert.equal(messages.rows[0]?.content, NOTE);
	} finally {
		installed.restore();
	}
});

test("histórico do modelo: a nota entra na posição dela como user [runtime], uma vez, nunca system", async () => {
	const installed = installFakes({ conversationMessage: seeded() });
	try {
		const recent = await loadRecentConversationMessages("c1", 40);
		// O clique ("cancela isso") ganha o rótulo de protocolo; a nota vem logo depois, no lugar em que ocorreu.
		assert.deepEqual(recent.map((message) => [message.role, message.content.split("\n")[0]]), [
			["user", "Manda o resumo para a Ana"],
			["user", "cancela isso"],
			["user", `[runtime] ${NOTE}`],
			["user", "e o painel?"],
		]);
		assert.equal(recent.some((message) => message.role === "system" || message.role === (OWNER_DECISION_ROLE as string)), false);
	} finally {
		installed.restore();
	}
});

test("depois da marca d'água (conversa contínua do v3) a nota também chega", async () => {
	const messages = seeded();
	const installed = installFakes({ conversationMessage: messages });
	try {
		const after = await loadMessagesAfterWatermark("c1", { messageId: "m2", count: 2 }, { excludeRunId: "r0" });
		assert.equal(after.ok, true);
		if (after.ok) assert.ok(after.messages.some((message) => message.role === "user" && message.content === `[runtime] ${NOTE}`));
	} finally {
		installed.restore();
	}
});

test("a tela e a prévia nunca recebem a nota", async () => {
	const findMany = prisma.conversationMessage.findMany;
	const queryRaw = prisma.$queryRaw;
	let listWhere: unknown;
	let previewSql = "";
	prisma.conversationMessage.findMany = (async (args: { where: unknown }) => { listWhere = args.where; return []; }) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.$queryRaw = (async (_strings: unknown, ...values: unknown[]) => { previewSql = JSON.stringify(values); return []; }) as unknown as typeof prisma.$queryRaw;
	try {
		await listConversationMessages("c1");
		assert.deepEqual((listWhere as { role?: unknown }).role, { not: OWNER_DECISION_ROLE });
		await lastConversationMessages(["c1"]);
		assert.match(previewSql, new RegExp(OWNER_DECISION_ROLE));
	} finally {
		prisma.conversationMessage.findMany = findMany;
		prisma.$queryRaw = queryRaw;
	}
});
