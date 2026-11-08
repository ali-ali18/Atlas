/**
 * Fonte de e-mail do plano do dia (F7.2) ligada à porta real de e-mail (F7.1). Só campos declarados (nunca o corpo), escopo do
 * dono do run, login expirado com `code: "needs_connection"` e uma fonte que falha não esconde a outra. Sem rede.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/brief-email.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmailAccount, EmailAccounts, EmailMessageSummary } from "@workspace/agent";
import { createBriefEmailForRun, createBriefEmailSource } from "./brief-email.js";
import { isGmailLoginProblem, type V4EmailDeps } from "./email.js";

const msg = (id: string, date: string, over: Partial<EmailMessageSummary> = {}): EmailMessageSummary => ({ id, from: "Contador <c@x.test>", subject: `Assunto ${id}`, snippet: "trecho curto", date, ...over });

function fakeAccounts(sources: Record<string, EmailMessageSummary[] | Error>, calls: string[] = []): EmailAccounts {
	return {
		list: async (userId) => (userId === "user-a" ? Object.keys(sources).map((source) => ({ source: source as "gmail" | "bot", label: source })) : []),
		open: async (userId, source) => {
			if (userId !== "user-a") return null;
			const result = sources[source];
			if (!result) return null;
			return {
				info: { source, label: source },
				list: async (id, query) => {
					calls.push(`list:${source}:${query.since}:${query.limit}${query.primaryOnly ? ":primary" : ""}`);
					if (result instanceof Error) throw result;
					return { messages: result };
				},
				read: async () => assert.fail("o brief nunca lê o corpo"),
				createDraft: async () => assert.fail("o brief nunca cria rascunho"),
				send: async () => assert.fail("o brief nunca envia"),
			} as EmailAccount;
		},
	};
}

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

test("só campos declarados: remetente, assunto, data e trecho; sem corpo, sem classificação inventada", async () => {
	const source = createBriefEmailSource(fakeAccounts({ gmail: [msg("m1", "2026-11-08T10:00:00.000Z", { unread: true, hasAttachment: true, threadId: "t" })] }));
	const items = await source.listRecent("user-a", { since: "2026-11-08T00:00:00.000Z", limit: 10 });
	assert.deepEqual(items, [{ id: "gmail:m1", from: "Contador <c@x.test>", subject: "Assunto m1", receivedAt: "2026-11-08T10:00:00.000Z", snippet: "trecho curto" }]);
});

test("filtra pelo instante de `since`, ordena do mais novo e respeita `limit` somando as duas fontes", async () => {
	const calls: string[] = [];
	const source = createBriefEmailSource(fakeAccounts({ gmail: [msg("old", "2026-11-07T23:00:00.000Z"), msg("g1", "2026-11-08T09:00:00.000Z")], bot: [msg("b1", "2026-11-08T11:00:00.000Z"), msg("b2", "2026-11-08T08:00:00.000Z")] }, calls));
	const items = await source.listRecent("user-a", { since: "2026-11-08T00:00:00.000Z", limit: 3 });
	assert.deepEqual(items.map((i) => i.id), ["bot:b1", "gmail:g1", "bot:b2"]);
	assert.deepEqual(calls, ["list:gmail:2026-11-08:3:primary", "list:bot:2026-11-08:3:primary"]);
});

test("IDOR: outro dono não vê as contas (lista vazia, sem chamar a caixa)", async () => {
	const calls: string[] = [];
	const source = createBriefEmailSource(fakeAccounts({ gmail: [msg("m1", "2026-11-08T10:00:00.000Z")] }, calls));
	await assert.rejects(source.listRecent("user-b", { since: "2026-11-08T00:00:00.000Z", limit: 10 }), (error: Error & { code?: string }) => error.code === "not_connected");
	assert.deepEqual(calls, []);
});

test("sem conta conectada (nunca conectou): sinal not_connected, não needs_connection (o brief ignora a fonte, sem pedir reconexão)", async () => {
	await assert.rejects(createBriefEmailSource(fakeAccounts({})).listRecent("user-a", { since: "2026-11-08T00:00:00.000Z", limit: 10 }), (error: Error & { code?: string }) => error.code === "not_connected");
});

test("login expirado: o erro leva code needs_connection", async () => {
	const source = createBriefEmailSource(fakeAccounts({ gmail: withCode("The Gmail login expired or was revoked. Hint: reconnect.", "needs_connection") }));
	await assert.rejects(source.listRecent("user-a", { since: "2026-11-08T00:00:00.000Z", limit: 10 }), (error: Error & { code?: string }) => error.code === "needs_connection" && /expired/.test(error.message));
});

test("falha comum não ganha needs_connection; se uma fonte lê, a outra que falhou não derruba o brief", async () => {
	const down = createBriefEmailSource(fakeAccounts({ gmail: new Error("Gmail failed: HTTP 500") }));
	await assert.rejects(down.listRecent("user-a", { since: "2026-11-08T00:00:00.000Z", limit: 10 }), (error: Error & { code?: string }) => error.code === undefined && /500/.test(error.message));
	const partial = createBriefEmailSource(fakeAccounts({ gmail: withCode("login", "needs_connection"), bot: [msg("b1", "2026-11-08T11:00:00.000Z")] }));
	assert.deepEqual((await partial.listRecent("user-a", { since: "2026-11-08T00:00:00.000Z", limit: 10 })).map((i) => i.id), ["bot:b1"]);
});

test("ponta a ponta com o adaptador do Gmail: token sem login vira needs_connection e o token nunca aparece", async () => {
	const deps = {
		listConnected: async (userId: string) => (userId === "user-a" ? [{ id: "c", catalogId: "gmail", accountLabel: "dono@exemplo.test", secretsEnc: "enc" }] : []),
		accessToken: async () => {
			throw new Error("The Gmail connection has no login. Hint: ask the owner to reconnect Gmail in Apps.");
		},
		googleFetch: (async () => assert.fail("sem rede")) as never,
		googleJson: (async (ctx: { getAccessToken: () => Promise<string> }) => {
			await ctx.getAccessToken();
			return {};
		}) as never,
		getMailbox: async () => null,
		persistCard: async () => undefined,
	} as unknown as V4EmailDeps;
	const source = createBriefEmailForRun({ scope: { ownerId: "user-a", botId: "bot-1", conversationId: "conv-1" }, deps });
	await assert.rejects(source.listRecent("user-a", { since: "2026-11-08T00:00:00.000Z", limit: 5 }), (error: Error & { code?: string }) => error.code === "needs_connection");
	// Outro dono, mesmo chamando a mesma fonte: nenhuma conta.
	await assert.rejects(source.listRecent("user-b", { since: "2026-11-08T00:00:00.000Z", limit: 5 }), (error: Error & { code?: string }) => error.code === "not_connected");
});

test("ponta a ponta com o Gmail: só lista os cabeçalhos (metadata), nunca pede o corpo (format=full)", async () => {
	const urls: string[] = [];
	const deps = {
		listConnected: async () => [{ id: "c", catalogId: "gmail", accountLabel: "dono@exemplo.test", secretsEnc: "enc" }],
		accessToken: async () => "tok",
		googleFetch: (async () => assert.fail("sem rede")) as never,
		googleJson: (async (_ctx: unknown, url: string) => {
			urls.push(url);
			if (url.includes("/messages?")) return { messages: [{ id: "m1" }] };
			return { id: "m1", threadId: "t1", snippet: "oi", internalDate: String(Date.parse("2026-11-08T10:00:00.000Z")), labelIds: [], payload: { headers: [{ name: "From", value: "Ana <a@x.test>" }, { name: "Subject", value: "Prazo" }] } };
		}) as never,
		getMailbox: async () => null,
		persistCard: async () => undefined,
	} as unknown as V4EmailDeps;
	const source = createBriefEmailForRun({ scope: { ownerId: "user-a", botId: null, conversationId: null }, deps });
	const items = await source.listRecent("user-a", { since: "2026-11-08T00:00:00.000Z", limit: 5 });
	assert.deepEqual(items.map((i) => i.subject), ["Prazo"]);
	assert.ok(urls.length === 2 && urls.every((url) => !url.includes("format=full")), urls.join("\n"));
});

test("isGmailLoginProblem: 401, UnauthorizedError e login ausente contam; 403, 500 e texto solto não", () => {
	class UnauthorizedError extends Error {}
	assert.equal(isGmailLoginProblem(Object.assign(new Error("HTTP 401"), { status: 401 })), true);
	assert.equal(isGmailLoginProblem(new UnauthorizedError("x")), true);
	assert.equal(isGmailLoginProblem(new Error("The Gmail connection has no login. Hint: reconnect.")), true);
	assert.equal(isGmailLoginProblem(Object.assign(new Error("HTTP 403"), { status: 403 })), false);
	assert.equal(isGmailLoginProblem(Object.assign(new Error("HTTP 500"), { status: 500 })), false);
	assert.equal(isGmailLoginProblem(new Error("login expired")), false);
	assert.equal(isGmailLoginProblem("401"), false);
});
