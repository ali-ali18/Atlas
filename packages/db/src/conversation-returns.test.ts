import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeConversationCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { cancelConversationReturn, claimDueReturn, createConversationReturn, ConversationReturnLimitError, listPendingReturns } from "./conversation-returns.js";
import { closePendingConfirmCard, dismissPendingQuestionnaireCard } from "./conversations.js";
import { markPendingLoginOutcome } from "./runs.js";

type ReturnRow = { id: string; userId: string; botId: string | null; conversationId: string; sourceRunId: string; dueAt: Date; reason: string; visible: boolean; status: string; runId: string | null; createdAt: Date };

/** `conversation_returns` em memória, com os filtros de dono/conversa/status aplicados como no banco. */
function fakeReturns(conversationOwner = "user-a") {
	const rows: ReturnRow[] = [];
	const matches = (row: ReturnRow, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key as keyof ReturnRow] === value);
	const original = { conv: prisma.conversation.findFirst, tx: prisma.$transaction, find: prisma.conversationReturn.findMany, findFirst: prisma.conversationReturn.findFirst, updateMany: prisma.conversationReturn.updateMany };
	prisma.conversation.findFirst = (async (args: { where: { userId?: string } }) => (args.where.userId === conversationOwner ? { id: "conv-1" } : null)) as unknown as typeof prisma.conversation.findFirst;
	const table = {
		count: async (args: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, args.where)).length,
		create: async (args: { data: Omit<ReturnRow, "id" | "status" | "runId" | "createdAt"> }) => {
			const row: ReturnRow = { id: `ret${rows.length}`, status: "pending", runId: null, createdAt: new Date(), ...args.data };
			rows.push(row);
			return row;
		},
	};
	prisma.$transaction = (async (fn: (tx: unknown) => Promise<unknown>) => fn({ $executeRaw: async () => 0, conversationReturn: table })) as unknown as typeof prisma.$transaction;
	prisma.conversationReturn.findMany = (async (args: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, args.where))) as unknown as typeof prisma.conversationReturn.findMany;
	prisma.conversationReturn.findFirst = (async (args: { where: Record<string, unknown> }) => rows.find((row) => matches(row, args.where)) ?? null) as unknown as typeof prisma.conversationReturn.findFirst;
	prisma.conversationReturn.updateMany = (async (args: { where: Record<string, unknown>; data: Partial<ReturnRow> }) => {
		const hit = rows.filter((row) => matches(row, args.where));
		for (const row of hit) Object.assign(row, args.data);
		return { count: hit.length };
	}) as unknown as typeof prisma.conversationReturn.updateMany;
	return {
		rows,
		restore: () => {
			prisma.conversation.findFirst = original.conv;
			prisma.$transaction = original.tx;
			Object.assign(prisma.conversationReturn, { findMany: original.find, findFirst: original.findFirst, updateMany: original.updateMany });
		},
	};
}

const base = { userId: "user-a", conversationId: "conv-1", sourceRunId: "run1", dueAt: new Date("2026-11-04T15:00:00Z"), reason: "ver o deploy", visible: true };

test("retorno: cria, lista, no máximo 3 pendentes por conversa", async () => {
	const db = fakeReturns();
	try {
		for (let index = 0; index < 3; index += 1) await createConversationReturn(base);
		await assert.rejects(createConversationReturn(base), ConversationReturnLimitError);
		assert.equal((await listPendingReturns("user-a", "conv-1")).length, 3);
	} finally {
		db.restore();
	}
});

test("retorno: usuário B não cria na conversa de A, não lista, não cancela nem dispara o de A", async () => {
	const db = fakeReturns();
	try {
		const mine = await createConversationReturn(base);
		await assert.rejects(createConversationReturn({ ...base, userId: "user-b" }));
		assert.deepEqual(await listPendingReturns("user-b", "conv-1"), []);
		assert.equal(await cancelConversationReturn("user-b", mine.id), null);
		assert.equal(await claimDueReturn("user-b", mine.id), null);
		assert.equal(db.rows[0]!.status, "pending");
	} finally {
		db.restore();
	}
});

test("retorno: cancelado não dispara; disparado uma vez só", async () => {
	const db = fakeReturns();
	try {
		const first = await createConversationReturn(base);
		const second = await createConversationReturn(base);
		assert.equal((await cancelConversationReturn("user-a", first.id))?.status, "cancelled");
		assert.equal(await claimDueReturn("user-a", first.id), null);
		assert.equal((await claimDueReturn("user-a", second.id))?.status, "fired");
		assert.equal(await claimDueReturn("user-a", second.id), null);
		assert.equal(await cancelConversationReturn("user-a", second.id), null);
	} finally {
		db.restore();
	}
});

/** Cartões da conversa em memória (`conversation_messages`), só da conversa do dono. */
function fakeCards(cards: Array<{ id: string; role: string; content: string }>, owner = "user-a") {
	const original = { conv: prisma.conversation.findFirst, find: prisma.conversationMessage.findMany, update: prisma.conversationMessage.update, updateMany: prisma.conversationMessage.updateMany };
	prisma.conversation.findFirst = (async (args: { where: { userId?: string } }) => (args.where.userId === owner ? { id: "conv-1" } : null)) as unknown as typeof prisma.conversation.findFirst;
	prisma.conversationMessage.findMany = (async (args: { where: { role: string } }) => cards.filter((card) => card.role === args.where.role)) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.update = (async (args: { where: { id: string }; data: { content: string } }) => {
		const card = cards.find((item) => item.id === args.where.id)!;
		card.content = args.data.content;
		return card;
	}) as unknown as typeof prisma.conversationMessage.update;
	prisma.conversationMessage.updateMany = (async (args: { where: { id: string; content: string }; data: { content: string } }) => {
		const card = cards.find((item) => item.id === args.where.id && item.content === args.where.content);
		if (!card) return { count: 0 };
		card.content = args.data.content;
		return { count: 1 };
	}) as unknown as typeof prisma.conversationMessage.updateMany;
	return () => Object.assign(prisma.conversationMessage, { findMany: original.find, update: original.update, updateMany: original.updateMany }) && (prisma.conversation.findFirst = original.conv);
}

test("cartão de confirmação: só fecha o pendente (decidido não muda) e só na conversa do dono", async () => {
	const cards = [
		{ id: "m2", role: "confirm", content: serializeConversationCard({ v: 1, kind: "confirm", confirmId: "c-new", title: "Novo?", status: "pending" }) },
		{ id: "m1", role: "confirm", content: serializeConversationCard({ v: 1, kind: "confirm", confirmId: "c-old", title: "Velho?", status: "approved" }) },
	];
	const restore = fakeCards(cards);
	try {
		assert.equal(await closePendingConfirmCard({ conversationId: "conv-1", ownerId: "user-b", status: "rejected", detail: "Dispensado" }), null);
		assert.equal(await closePendingConfirmCard({ conversationId: "conv-1", ownerId: "user-a", confirmId: "c-old", status: "rejected", detail: "Dispensado" }), null);
		assert.match(cards[1]!.content, /"approved"/);
		assert.deepEqual(await closePendingConfirmCard({ conversationId: "conv-1", ownerId: "user-a", status: "rejected", detail: "Dispensado" }), { confirmId: "c-new", title: "Novo?" });
		assert.match(cards[0]!.content, /"rejected"/);
		assert.match(cards[0]!.content, /Dispensado/);
	} finally {
		restore();
	}
});

test("questionário: pular/ignorar fecha o pendente como dispensado; outro usuário não", async () => {
	const cards = [{ id: "q1", role: "questionnaire", content: serializeConversationCard({ v: 1, kind: "questionnaire", questionnaireId: "questionnaire-run1", title: "Formato?", items: [{ name: "f", prompt: "Formato?", choices: [{ value: "pptx", label: "pptx" }] }], status: "pending" } as unknown as Parameters<typeof serializeConversationCard>[0]) }];
	const restore = fakeCards(cards);
	try {
		assert.equal(await dismissPendingQuestionnaireCard({ conversationId: "conv-1", ownerId: "user-b" }), null);
		assert.deepEqual(await dismissPendingQuestionnaireCard({ conversationId: "conv-1", ownerId: "user-a", questionnaireId: "questionnaire-run1" }), { questionnaireId: "questionnaire-run1", title: "Formato?" });
		assert.match(cards[0]!.content, /"dismissed"/);
		assert.equal(await dismissPendingQuestionnaireCard({ conversationId: "conv-1", ownerId: "user-a" }), null);
	} finally {
		restore();
	}
});

test("login/VM: a saída do cartão só vale para o run do dono que espera aquele login", async () => {
	const run = { id: "run1", userId: "user-a", checkpointJson: { version: 2, messages: [], pendingLogin: { loginId: "login-1", site: "x", url: "https://x" } } as Record<string, unknown> };
	const original = { findFirst: prisma.agentRun.findFirst, updateMany: prisma.agentRun.updateMany };
	prisma.agentRun.findFirst = (async (args: { where: { id: string; userId: string } }) => (args.where.id === run.id && args.where.userId === run.userId ? run : null)) as unknown as typeof prisma.agentRun.findFirst;
	prisma.agentRun.updateMany = (async (args: { where: { userId: string }; data: { checkpointJson: Record<string, unknown> } }) => {
		if (args.where.userId !== run.userId) return { count: 0 };
		run.checkpointJson = args.data.checkpointJson;
		return { count: 1 };
	}) as unknown as typeof prisma.agentRun.updateMany;
	try {
		assert.equal(await markPendingLoginOutcome({ runId: "run1", userId: "user-b", outcome: "skipped" }), false);
		assert.equal(await markPendingLoginOutcome({ runId: "run1", userId: "user-a", outcome: "skipped", loginId: "outro" }), false);
		assert.equal(await markPendingLoginOutcome({ runId: "run1", userId: "user-a", outcome: "skipped", loginId: "login-1" }), true);
		assert.equal((run.checkpointJson.pendingLogin as { outcome?: string }).outcome, "skipped");
	} finally {
		Object.assign(prisma.agentRun, original);
	}
});
