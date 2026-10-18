import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { maybeHandleConfirmedAction } = await import("./confirmed-action.js");

const USER = "user-a";
const CONV = "conv-dup";

function cardJson(status: string, dev = true) {
	return JSON.stringify({
		v: 1,
		kind: "confirm",
		confirmId: "confirm-r1-abcd1234",
		title: "Executar este comando?",
		status,
		callKey: "k1",
		...(dev ? { devApproval: { kind: "command", command: "make deploy", cwd: "/workspace" } } : {}),
	});
}

function fakeDb(options: { pending: boolean; cardStatus: string; dev?: boolean; claimCount?: number }) {
	const state = { updates: 0, claims: 0 };
	const originals = {
		find: prisma.skillPendingIntent.findUnique,
		del: prisma.skillPendingIntent.deleteMany,
		findMany: prisma.conversationMessage.findMany,
		update: prisma.conversationMessage.update,
	};
	prisma.skillPendingIntent.findUnique = (async () =>
		options.pending
			? {
					id: "p1",
					userId: USER,
					conversationId: CONV,
					kind: "confirm",
					expiresAt: new Date(Date.now() + 60_000),
					payload: { kind: "confirm", action: "dev-command", confirmId: "confirm-r1-abcd1234", devCommand: { callKey: "k1", sessionId: "s1", repo: "octo/hello", tool: "shell", label: "make deploy", prefixes: [] } },
				}
			: null) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.skillPendingIntent.deleteMany = (async () => {
		state.claims += 1;
		return { count: options.claimCount ?? 1 };
	}) as unknown as typeof prisma.skillPendingIntent.deleteMany;
	prisma.conversationMessage.findMany = (async () => [{ id: "m1", content: cardJson(options.cardStatus, options.dev ?? true), createdAt: new Date() }]) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.update = (async () => {
		state.updates += 1;
		return {};
	}) as unknown as typeof prisma.conversationMessage.update;
	return {
		state,
		restore() {
			prisma.skillPendingIntent.findUnique = originals.find;
			prisma.skillPendingIntent.deleteMany = originals.del;
			prisma.conversationMessage.findMany = originals.findMany;
			prisma.conversationMessage.update = originals.update;
		},
	};
}

const click = (text = "confirmado: Executar este comando?") =>
	maybeHandleConfirmedAction({ text, userId: USER, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true });

test("Executar repetido depois de aprovado: duplicata, sem follow-up (não vira mensagem nem run)", async () => {
	const db = fakeDb({ pending: false, cardStatus: "approved" });
	try {
		const result = await click();
		assert.deepEqual(result, { handled: false, duplicate: true });
		assert.equal(db.state.updates, 0);
		const always = await click("confirmado sempre: Executar este comando?");
		assert.deepEqual(always, { handled: false, duplicate: true });
	} finally {
		db.restore();
	}
});

test("cartão recusado/pulado e Executar repetido também é duplicata", async () => {
	const db = fakeDb({ pending: false, cardStatus: "rejected" });
	try {
		assert.deepEqual(await click(), { handled: false, duplicate: true });
	} finally {
		db.restore();
	}
});

test("sem intenção pendente mas cartão ainda pendente, ou cartão que não é de código: segue o fluxo antigo", async () => {
	const stillPending = fakeDb({ pending: false, cardStatus: "pending" });
	try {
		assert.deepEqual(await click(), { handled: false });
	} finally {
		stillPending.restore();
	}
	const notDev = fakeDb({ pending: false, cardStatus: "approved", dev: false });
	try {
		assert.deepEqual(await click(), { handled: false });
	} finally {
		notDev.restore();
	}
});

test("dois cliques simultâneos: quem perde a reserva da intenção é duplicata e não toca no cartão", async () => {
	const lost = fakeDb({ pending: true, cardStatus: "pending", claimCount: 0 });
	try {
		assert.deepEqual(await click(), { handled: false, duplicate: true });
		assert.equal(lost.state.updates, 0);
	} finally {
		lost.restore();
	}
	const won = fakeDb({ pending: true, cardStatus: "pending", claimCount: 1 });
	try {
		const result = await click();
		assert.equal(result.handled, false);
		assert.equal("duplicate" in result && result.duplicate, false);
		assert.ok(!result.handled && result.followUp);
		assert.equal(won.state.updates, 1);
	} finally {
		won.restore();
	}
});

test("Pular repetido (intenção já reservada) também não duplica", async () => {
	const db = fakeDb({ pending: true, cardStatus: "pending", claimCount: 0 });
	try {
		assert.deepEqual(await click("cancela isso"), { handled: false, duplicate: true });
	} finally {
		db.restore();
	}
});
