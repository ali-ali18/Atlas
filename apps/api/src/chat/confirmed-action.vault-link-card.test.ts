import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
process.env.CONNECTOR_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const { prisma } = await import("@workspace/db");
const { maybeHandleConfirmedAction } = await import("./confirmed-action.js");
const { VaultService, memoryVaultStore, setVaultServiceForTests } = await import("@workspace/agent-runtime");

const USER = "user-a";
const CONV = "conv-1";
const CARD = "confirm-vault-0123456789-cmrun1";

/** Intenção pendente `vault-use` com `linkHost` (cartão de vínculo) e o cartão, em memória. */
async function setup() {
	const vault = new VaultService(memoryVaultStore());
	setVaultServiceForTests(vault);
	const item = await vault.create(USER, { kind: "login", name: "painel-kodea", label: "Painel - Kodea", username: "dono@x.com", payload: { password: "Senha!123" } });
	const state = { cleared: false, status: "pending" };
	const originals = { find: prisma.skillPendingIntent.findUnique, del: prisma.skillPendingIntent.deleteMany, many: prisma.conversationMessage.findMany, update: prisma.conversationMessage.update };
	prisma.skillPendingIntent.findUnique = (async () => ({
		id: "p1", userId: USER, conversationId: CONV, kind: "confirm", expiresAt: new Date(Date.now() + 60_000),
		payload: { kind: "confirm", action: "vault-use", confirmId: CARD, vaultUse: { secretId: item.id, name: "painel-kodea", label: "Painel - Kodea", domain: "panel.kodea.com.br", linkHost: "panel.kodea.com.br" } },
	})) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.skillPendingIntent.deleteMany = (async () => { state.cleared = true; return { count: 1 }; }) as unknown as typeof prisma.skillPendingIntent.deleteMany;
	prisma.conversationMessage.findMany = (async () => [{ id: "m1", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: CARD, title: "Usar?", status: state.status }), createdAt: new Date() }]) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.update = (async (args: { data: { content: string } }) => { state.status = (JSON.parse(args.data.content) as { status: string }).status; return {}; }) as unknown as typeof prisma.conversationMessage.update;
	const siteOf = async () => (await vault.listMeta(USER)).find((i) => i.id === item.id)!.siteUrl ?? "";
	return { state, siteOf, restore: () => { setVaultServiceForTests(null); Object.assign(prisma.skillPendingIntent, { findUnique: originals.find, deleteMany: originals.del }); Object.assign(prisma.conversationMessage, { findMany: originals.many, update: originals.update }); } };
}

const run = (text: string, confirmId?: string) => maybeHandleConfirmedAction({ text, userId: USER, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true, ...(confirmId ? { confirmId } : {}) });

test('"sim" digitado não vincula o site: só o botão do cartão grava o host', async () => {
	for (const typed of ["sim", "Sim, pode", "ok", "confirmado", "confirmado: Usar o login do Cofre Painel - Kodea em panel.kodea.com.br?"]) {
		const ctx = await setup();
		try {
			// jev diz que é um "sim" em qualquer idioma: ainda assim, texto digitado nunca vincula
			const result = await maybeHandleConfirmedAction({ text: typed, userId: USER, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true, jevIntent: async () => ({ cancel: false, confirm: true }) });
			assert.equal(result.handled, false, typed);
			assert.equal((result as { followUp?: unknown }).followUp, undefined, typed);
			assert.equal(await ctx.siteOf(), "", typed);
			assert.equal(ctx.state.cleared, false, `${typed}: a intenção segue pendente`);
			assert.equal(ctx.state.status, "pending", typed);
		} finally { ctx.restore(); }
	}
});

test("o botão do cartão (confirmId do cartão) grava o host exato do cartão", async () => {
	const ctx = await setup();
	try {
		const result = await run("confirmado: Usar o login do Cofre Painel - Kodea em panel.kodea.com.br?", CARD);
		assert.equal(result.handled, false);
		assert.match((result as { followUp: { content: string } }).followUp.content, /panel\.kodea\.com\.br/);
		assert.equal(await ctx.siteOf(), "https://panel.kodea.com.br");
		assert.equal(ctx.state.status, "approved");
	} finally { ctx.restore(); }
});

test("botão de outro cartão (o 1º, já substituído) não vincula o host do cartão pendente", async () => {
	const ctx = await setup();
	try {
		const result = await run("confirmado: Usar o login do Cofre Painel - Kodea em outro.example?", "confirm-vault-aaaaaaaaaa-cmrun1");
		assert.equal((result as { duplicate?: boolean }).duplicate, true);
		assert.equal(await ctx.siteOf(), "");
		assert.equal(ctx.state.cleared, false);
	} finally { ctx.restore(); }
});
