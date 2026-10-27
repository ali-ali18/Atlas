import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { isConfirmAlways, rememberAlwaysAllow } = await import("./confirmed-action.js");

test("isConfirmAlways só reconhece a terceira ação do card", () => {
	assert.equal(isConfirmAlways("confirmado sempre: Google Agenda: executar create_event?"), true);
	assert.equal(isConfirmAlways("Confirmado sempre"), true);
	assert.equal(isConfirmAlways("confirmado: Google Agenda: executar create_event?"), false);
	assert.equal(isConfirmAlways("cancela isso"), false);
});

function fakeBot(ownerId: string | null) {
	const store = { autonomyJson: null as unknown };
	const originalFind = prisma.bot.findFirst;
	const originalUpdate = prisma.bot.update;
	prisma.bot.findFirst = (async (args: { where: { ownerId: { in: Array<string | null> } } }) =>
		args.where.ownerId.in.includes(ownerId)
			? { id: "bot-1", name: "Taldo", autonomyJson: store.autonomyJson }
			: null) as unknown as typeof prisma.bot.findFirst;
	prisma.bot.update = (async (args: { data: { autonomyJson: unknown } }) => {
		store.autonomyJson = args.data.autonomyJson;
		return {};
	}) as unknown as typeof prisma.bot.update;
	return {
		store,
		restore: () => {
			prisma.bot.findFirst = originalFind;
			prisma.bot.update = originalUpdate;
		},
	};
}

test("'Não perguntar mais' cria never_ask da tool no bot, só para escrita reversível", async () => {
	const fake = fakeBot("user-a");
	try {
		const call = { exposedName: "mcp__google_calendar__create_event" };
		assert.equal(await rememberAlwaysAllow({ userId: "user-a", botId: "bot-1", call: { ...call, actionClass: "write" } }), true);
		assert.deepEqual(fake.store.autonomyJson, { exceptions: [{ tool: call.exposedName, mode: "never_ask" }] });
	} finally {
		fake.restore();
	}
});

test("irreversível ou sem classe nunca vira never_ask por esse caminho", async () => {
	const fake = fakeBot("user-a");
	try {
		const exposedName = "mcp__google_calendar__delete_event";
		assert.equal(await rememberAlwaysAllow({ userId: "user-a", botId: "bot-1", call: { exposedName, actionClass: "irreversible" } }), false);
		assert.equal(await rememberAlwaysAllow({ userId: "user-a", botId: "bot-1", call: { exposedName } }), false);
		assert.equal(fake.store.autonomyJson, null);
	} finally {
		fake.restore();
	}
});

test("bot de outro usuário: nada é gravado", async () => {
	const fake = fakeBot("user-a");
	try {
		const ok = await rememberAlwaysAllow({
			userId: "user-b",
			botId: "bot-1",
			call: { exposedName: "mcp__x__y", actionClass: "write" },
		});
		assert.equal(ok, false);
		assert.equal(fake.store.autonomyJson, null);
	} finally {
		fake.restore();
	}
});

test("aprovação por tarefa: só escrita reversível sem segredo, só em conversa do dono", async () => {
	const { grantAfterApproval } = await import("./confirmed-action.js");
	const originalFind = prisma.conversation.findFirst;
	const originalUpsert = prisma.mcpTaskGrant.upsert;
	const upserts: Array<{ create: { userId: string; conversationId: string; connectionId: string; exposedName: string; uses: number; maxUses: number } }> = [];
	prisma.conversation.findFirst = (async (args: { where: { id: string; userId: string } }) =>
		args.where.id === "conv-a" && args.where.userId === "user-a" ? { id: "conv-a" } : null) as unknown as typeof prisma.conversation.findFirst;
	prisma.mcpTaskGrant.upsert = (async (args: (typeof upserts)[number]) => {
		upserts.push(args);
		return { ...args.create, confirmId: null };
	}) as unknown as typeof prisma.mcpTaskGrant.upsert;
	const info = vi_noop();
	try {
		const call = { connectionId: "conn-1", exposedName: "mcp__google_calendar__create_event", actionClass: "write" as const, args: { summary: "Prova" } };
		assert.deepEqual(await grantAfterApproval({ userId: "user-a", conversationId: "conv-a", call, confirmId: "c1" }), { uses: 1, maxUses: 30 });
		assert.equal(upserts[0]?.create.userId, "user-a");
		assert.equal(upserts[0]?.create.connectionId, "conn-1");
		assert.equal(await grantAfterApproval({ userId: "user-b", conversationId: "conv-a", call }), undefined, "outro usuário não concede");
		assert.equal(await grantAfterApproval({ userId: "user-a", conversationId: "conv-x", call }), undefined, "outra conversa");
		assert.equal(await grantAfterApproval({ userId: "user-a", conversationId: "conv-a", call: { ...call, actionClass: "irreversible" } }), undefined, "irreversível nunca");
		assert.equal(await grantAfterApproval({ userId: "user-a", conversationId: "conv-a", call: { ...call, actionClass: undefined } }), undefined);
		assert.equal(upserts.length, 1);
	} finally {
		info();
		prisma.conversation.findFirst = originalFind;
		prisma.mcpTaskGrant.upsert = originalUpsert;
	}
});

/** Silencia o log de auditoria durante o teste; devolve a função que restaura. */
function vi_noop(): () => void {
	const original = console.info;
	console.info = () => undefined;
	return () => {
		console.info = original;
	};
}
