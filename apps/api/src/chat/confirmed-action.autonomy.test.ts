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
