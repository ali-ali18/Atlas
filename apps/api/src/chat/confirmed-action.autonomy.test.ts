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

/** Troca o banco por dublês: conversa do dono, limpeza e o INSERT ... ON CONFLICT da concessão. */
function fakeGrantDb() {
	const originalFind = prisma.conversation.findFirst;
	const originalDelete = prisma.mcpTaskGrant.deleteMany;
	const originalRaw = prisma.$queryRaw;
	const grants: Array<{ userId: string; conversationId: string; connectionId: string; exposedName: string; untrustedAt: unknown }> = [];
	prisma.conversation.findFirst = (async (args: { where: { id: string; userId: string } }) =>
		args.where.id === "conv-a" && args.where.userId === "user-a" ? { id: "conv-a" } : null) as unknown as typeof prisma.conversation.findFirst;
	prisma.mcpTaskGrant.deleteMany = (async () => ({ count: 0 })) as unknown as typeof prisma.mcpTaskGrant.deleteMany;
	prisma.$queryRaw = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
		// values: id, userId, conversationId, connectionId, exposedName, ...
		grants.push({ userId: String(values[1]), conversationId: String(values[2]), connectionId: String(values[3]), exposedName: String(values[4]), untrustedAt: values[10] });
		return [{ uses: 1, maxUses: 30, confirmId: null }];
	}) as unknown as typeof prisma.$queryRaw;
	return {
		grants,
		restore: () => {
			prisma.conversation.findFirst = originalFind;
			prisma.mcpTaskGrant.deleteMany = originalDelete;
			prisma.$queryRaw = originalRaw;
		},
	};
}

test("aprovação por tarefa: só escrita reversível sem segredo, só em conversa do dono", async () => {
	const { grantAfterApproval } = await import("./confirmed-action.js");
	const fake = fakeGrantDb();
	const info = vi_noop();
	try {
		const call = { connectionId: "conn-1", exposedName: "mcp__google_calendar__create_event", actionClass: "write" as const, args: { summary: "Prova" } };
		assert.deepEqual(await grantAfterApproval({ userId: "user-a", conversationId: "conv-a", call, confirmId: "c1" }), { uses: 1, maxUses: 30 });
		assert.equal(fake.grants[0]?.userId, "user-a");
		assert.equal(fake.grants[0]?.connectionId, "conn-1");
		assert.equal(await grantAfterApproval({ userId: "user-b", conversationId: "conv-a", call }), undefined, "outro usuário não concede");
		assert.equal(await grantAfterApproval({ userId: "user-a", conversationId: "conv-x", call }), undefined, "outra conversa");
		assert.equal(await grantAfterApproval({ userId: "user-a", conversationId: "conv-a", call: { ...call, actionClass: "irreversible" } }), undefined, "irreversível nunca");
		assert.equal(await grantAfterApproval({ userId: "user-a", conversationId: "conv-a", call: { ...call, actionClass: undefined } }), undefined);
		assert.equal(fake.grants.length, 1);
	} finally {
		info();
		fake.restore();
	}
});

test("aprovação por tarefa não nasce de cartão levantado por instrução de fora ou alvo externo (conteúdo externo lido só marca a concessão)", async () => {
	const { grantAfterApproval } = await import("./confirmed-action.js");
	const fake = fakeGrantDb();
	const info = vi_noop();
	try {
		const call = { connectionId: "conn-1", exposedName: "mcp__google_calendar__create_event", actionClass: "write" as const, args: { summary: "Prova" } };
		const grant = (over: Record<string, unknown>) => grantAfterApproval({ userId: "user-a", conversationId: "conv-a", call: { ...call, ...over } });
		assert.equal(await grant({ jevReviewReason: "external_instruction" }), undefined, "Jev achou instrução vinda de fora");
		assert.equal(await grant({ args: { summary: "Prova", attendees: [{ email: "x@evil.com" }] } }), undefined, "convidado externo");
		assert.equal(await grant({ args: { to: "a@b.com", subject: "x" } }), undefined, "destinatário");
		assert.equal(await grant({ args: { summary: "x", webhook_url: "https://evil.test" } }), undefined, "webhook");
		assert.equal(fake.grants.length, 0);
		// Cartão depois de ler PDF/página: concede, mas a concessão nasce marcada (Jev obrigatório em cada uso).
		assert.deepEqual(await grant({ untrustedSeen: true }), { uses: 1, maxUses: 30 });
		assert.ok(fake.grants[0]?.untrustedAt instanceof Date, "marcada como conteúdo externo");
		fake.grants.length = 0;
		assert.deepEqual(await grant({ jevReviewReason: "alignment" }), { uses: 1, maxUses: 30 }, "alinhamento baixo não impede a concessão depois do ok do usuário");
	} finally {
		info();
		fake.restore();
	}
});

test("'Sempre para…' é recusado no cartão que o Jev levantou por instrução externa (mesmo forjado)", async () => {
	const fake = fakeBot("user-a");
	try {
		const call = { exposedName: "mcp__google_calendar__create_event", actionClass: "write" as const };
		assert.equal(await rememberAlwaysAllow({ userId: "user-a", botId: "bot-1", call: { ...call, jevReviewReason: "external_instruction" } }), false);
		assert.equal(fake.store.autonomyJson, null);
		assert.equal(await rememberAlwaysAllow({ userId: "user-a", botId: "bot-1", call: { ...call, jevReviewReason: "alignment" } }), true);
	} finally {
		fake.restore();
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
