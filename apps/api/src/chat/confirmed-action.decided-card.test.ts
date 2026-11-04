import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { maybeHandleConfirmedAction } = await import("./confirmed-action.js");

/**
 * Corrida prazo × clique (auditoria do PR8a): um clique repetido ou atrasado num cartão que já foi decidido (pelo dono ou
 * pelo prazo) não troca o desfecho. Antes, "Permitir" sem intenção viva marcava o cartão como recusado mesmo aprovado.
 */
function fakeDb(status: "approved" | "rejected") {
	const state = { content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "confirm-toolab12cd34-run9", title: "Criar um link público do painel?", status, callKey: "k", outcome: { ok: status === "approved", detail: "x" } }) };
	const originals = { find: prisma.skillPendingIntent.findUnique, conv: prisma.conversation.findFirst, many: prisma.conversationMessage.findMany, update: prisma.conversationMessage.update, updateMany: prisma.conversationMessage.updateMany, run: prisma.agentRun.findFirst };
	prisma.skillPendingIntent.findUnique = (async () => null) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.agentRun.findFirst = (async () => null) as unknown as typeof prisma.agentRun.findFirst;
	prisma.conversation.findFirst = (async () => ({ id: "conv-1" })) as unknown as typeof prisma.conversation.findFirst;
	prisma.conversationMessage.findMany = (async () => [{ id: "m1", role: "confirm", content: state.content, createdAt: new Date() }]) as unknown as typeof prisma.conversationMessage.findMany;
	const write = async (args: { data: { content: string } }) => { state.content = args.data.content; return { count: 1 }; };
	prisma.conversationMessage.update = write as unknown as typeof prisma.conversationMessage.update;
	prisma.conversationMessage.updateMany = write as unknown as typeof prisma.conversationMessage.updateMany;
	return { state, restore: () => { prisma.skillPendingIntent.findUnique = originals.find; prisma.conversation.findFirst = originals.conv; prisma.agentRun.findFirst = originals.run; Object.assign(prisma.conversationMessage, { findMany: originals.many, update: originals.update, updateMany: originals.updateMany }); } };
}

for (const status of ["approved", "rejected"] as const) {
	test(`clique em cartão já ${status === "approved" ? "aprovado" : "recusado (prazo)"} não troca o desfecho`, async () => {
		const db = fakeDb(status);
		try {
			await maybeHandleConfirmedAction({ text: "confirmado: Criar um link público do painel?", confirmId: "confirm-toolab12cd34-run9", userId: "user-a", botId: "bot-1", conversationId: "conv-1", model: "m", continueInAgent: true });
			assert.equal((JSON.parse(db.state.content) as { status: string }).status, status);
		} finally {
			db.restore();
		}
	});
}
