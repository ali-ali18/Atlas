/**
 * E-mail do v4 no worker (F7.1): Gmail do dono (token do cofre, REST) e caixa do bot. Escopo por dono e por bot, token nunca em
 * erro, envio sem o escopo vira dica honesta, cartões uma vez por identidade. Sem rede: o Google e o provedor são falsos.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/email.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotMailboxRecord } from "@workspace/db";
import type { ComputerUseEvent } from "@workspace/shared";
import { buildGmailRaw, botMailErrorMessage, createV4Email, gmailBodyText, gmailErrorMessage, gmailQuery, htmlToText, type V4EmailDeps, type V4BotMailService } from "./email.js";

const TOKEN = "ya29.TOKEN-SECRETO-DO-DONO";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

class GoogleStatusError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

type Call = { url: string; method: string; body?: unknown };

function gmailRig(over: { failWith?: Error; messages?: Record<string, unknown>; connections?: Array<{ userId: string; catalogId: string | null; id: string }> } = {}) {
	const calls: Call[] = [];
	const messages: Record<string, unknown> = over.messages ?? {};
	const connections = over.connections ?? [{ userId: "user-a", catalogId: "gmail", id: "conn-a" }];
	const deps: Partial<V4EmailDeps> = {
		listConnected: async (userId) => connections.filter((c) => c.userId === userId).map((c) => ({ id: c.id, catalogId: c.catalogId, accountLabel: "dono@exemplo.test", secretsEnc: "enc" })) as never,
		accessToken: async () => TOKEN,
		googleFetch: (async () => assert.fail("googleFetch só via googleJson")) as never,
		googleJson: (async (_ctx: unknown, url: string, init?: RequestInit) => {
			// Quem chama sempre pede o token: o contexto leva a função, e o teste a exercita.
			await (_ctx as { getAccessToken: () => Promise<string> }).getAccessToken();
			calls.push({ url, method: init?.method ?? "GET", ...(init?.body && { body: JSON.parse(String(init.body)) }) });
			if (over.failWith) throw over.failWith;
			if (url.includes("/messages?")) return { messages: Object.keys(messages).map((id) => ({ id })) };
			if (url.endsWith("/drafts")) return { id: "draft-1" };
			if (url.endsWith("/messages/send")) return { id: "sent-1", threadId: "thr-1" };
			const id = decodeURIComponent(url.split("/messages/")[1]!.split("?")[0]!);
			if (!messages[id]) throw new GoogleStatusError(404, "HTTP 404: Requested entity was not found.");
			return messages[id];
		}) as never,
		getMailbox: async () => null,
		persistCard: async () => undefined,
	};
	return { deps: deps as V4EmailDeps, calls };
}

const scope = (over: Record<string, unknown> = {}) => ({ ownerId: "user-a", botId: "bot-1", conversationId: "conv-1", emit: () => undefined, ...over });

test("gmailQuery: valores entram entre aspas e nunca viram operador; sem remetente nem assunto, é a caixa de entrada", () => {
	assert.equal(gmailQuery({}), "in:inbox");
	assert.equal(gmailQuery({ unread: true, since: "2026-11-01", until: "2026-11-08" }), 'is:unread after:2026/11/01 before:2026/11/08 in:inbox');
	assert.equal(gmailQuery({ from: 'ana" OR in:trash', subject: "fatura\n" }), 'from:"ana OR in:trash" subject:"fatura"');
});

test("htmlToText e gmailBodyText: texto puro vence; HTML perde estilo/script/tags e decodifica entidades", () => {
	assert.equal(htmlToText("<style>p{}</style><p>Olá &amp; bem-vindo</p><script>x()</script><p>Linha 2</p>"), "Olá & bem-vindo\nLinha 2");
	assert.equal(gmailBodyText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<p>HTML</p>") } }, { mimeType: "text/plain", body: { data: b64("Texto puro") } }] }), "Texto puro");
	assert.equal(gmailBodyText({ mimeType: "text/html", body: { data: b64("<b>só html</b>") } }), "só html");
	assert.equal(gmailBodyText({ mimeType: "multipart/mixed" }), "");
});

test("buildGmailRaw: cabeçalhos sem quebra injetada, assunto acentuado em RFC 2047, corpo em base64 e encadeamento da resposta", () => {
	const raw = buildGmailRaw({ to: ["ana@empresa.test"], cc: ["b@y.test"], subject: "Orçamento\r\nBcc: x@y.test", body: "Olá, aprovado.", inReplyTo: "<m1@x>", references: "<m0@x> <m1@x>" });
	const text = Buffer.from(raw, "base64url").toString("utf8");
	const head = text.split("\r\n\r\n")[0]!;
	assert.match(head, /^To: ana@empresa.test\r\nCc: b@y.test\r\nSubject: =\?UTF-8\?B\?/);
	assert.ok(!head.split("\r\n").some((line) => line.startsWith("Bcc:")), "assunto não injeta cabeçalho");
	assert.match(head, /In-Reply-To: <m1@x>\r\nReferences: <m0@x> <m1@x>/);
	assert.equal(Buffer.from(text.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8"), "Olá, aprovado.");
});

test("contas: Gmail do dono + caixa do bot; outro dono, outro bot e caixa desligada não aparecem", async () => {
	const { deps } = gmailRig({ connections: [{ userId: "user-a", catalogId: "gmail", id: "a" }, { userId: "user-b", catalogId: "gmail", id: "b" }, { userId: "user-a", catalogId: "slack", id: "s" }] });
	const mailbox = { id: "mb", botId: "bot-1", userId: "user-a", address: "bot@openmail.test", enabled: true } as BotMailboxRecord;
	deps.getMailbox = async (botId, userId) => (botId === "bot-1" && userId === "user-a" ? mailbox : null);
	const ports = createV4Email({ scope: scope(), deps });
	assert.deepEqual((await ports.accounts.list("user-a")).map((a) => a.source), ["gmail", "bot"]);
	// Outro dono (mesmo com o userId no argumento): nada.
	assert.deepEqual(await ports.accounts.list("user-b"), []);
	assert.equal(await ports.accounts.open("user-b", "gmail"), null);
	assert.equal(await ports.accounts.open("user-b", "bot"), null);
	// Outro bot do mesmo dono: a caixa é do bot do run.
	const otherBot = createV4Email({ scope: scope({ botId: "bot-2" }), deps });
	assert.deepEqual((await otherBot.accounts.list("user-a")).map((a) => a.source), ["gmail"]);
	assert.equal(await otherBot.accounts.open("user-a", "bot"), null);
	// Sem bot no run: sem caixa.
	assert.equal(await createV4Email({ scope: scope({ botId: null }), deps }).accounts.open("user-a", "bot"), null);
	// Caixa desligada.
	deps.getMailbox = async () => ({ ...mailbox, enabled: false });
	assert.equal(await createV4Email({ scope: scope(), deps }).accounts.open("user-a", "bot"), null);
});

test("Gmail: lista traz remetente, assunto, data e não lido; a conta recusa outro userId", async () => {
	const { deps, calls } = gmailRig({
		messages: {
			m1: { id: "m1", threadId: "t1", snippet: "Preciso do ok", labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.parse("2026-11-07T10:00:00Z")), payload: { headers: [{ name: "From", value: "Ana <ana@empresa.test>" }, { name: "Subject", value: "Orçamento" }] } },
		},
	});
	const account = (await createV4Email({ scope: scope(), deps }).accounts.open("user-a", "gmail"))!;
	const out = await account.list("user-a", { unread: true, limit: 10 });
	assert.deepEqual(out.messages, [{ id: "m1", threadId: "t1", from: "Ana <ana@empresa.test>", subject: "Orçamento", snippet: "Preciso do ok", date: "2026-11-07T10:00:00.000Z", unread: true }]);
	assert.ok(calls[0]!.url.includes("q=is%3Aunread+in%3Ainbox"));
	await assert.rejects(account.list("user-b", { limit: 5 }), /not connected/);
});

test("Gmail: leitura traz corpo, destinatários e nomes de anexo; id inexistente vira 'não encontrada'", async () => {
	const { deps } = gmailRig({
		messages: {
			m1: { id: "m1", threadId: "t1", internalDate: "0", payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: "ana@empresa.test" }, { name: "To", value: "dono@exemplo.test, b@y.test" }, { name: "Subject", value: "Contrato" }], parts: [{ mimeType: "text/plain", body: { data: b64("Segue o contrato.") } }, { mimeType: "application/pdf", filename: "contrato.pdf", body: {} }] } },
		},
	});
	const account = (await createV4Email({ scope: scope(), deps }).accounts.open("user-a", "gmail"))!;
	const message = await account.read("user-a", "m1");
	assert.equal(message.body, "Segue o contrato.");
	assert.deepEqual(message.to, ["dono@exemplo.test", "b@y.test"]);
	assert.deepEqual(message.attachments, ["contrato.pdf"]);
	await assert.rejects(account.read("user-a", "nada"), /Message not found/);
});

test("Gmail: rascunho e envio levam o encadeamento da resposta (conversa, In-Reply-To, assunto 'Re:')", async () => {
	const { deps, calls } = gmailRig({ messages: { m1: { id: "m1", threadId: "t1", payload: { headers: [{ name: "Subject", value: "Orçamento" }, { name: "Message-ID", value: "<m1@x>" }] } } } });
	const account = (await createV4Email({ scope: scope(), deps }).accounts.open("user-a", "gmail"))!;
	const draft = await account.createDraft("user-a", { to: ["ana@empresa.test"], body: "Aprovado.", inReplyTo: "m1" });
	assert.deepEqual(draft, { saved: true, draftId: "draft-1", to: ["ana@empresa.test"], subject: "Re: Orçamento" });
	const posted = calls.find((c) => c.url.endsWith("/drafts"))!.body as { message: { raw: string; threadId: string } };
	assert.equal(posted.message.threadId, "t1");
	assert.match(Buffer.from(posted.message.raw, "base64url").toString("utf8"), /In-Reply-To: <m1@x>/);
	const sent = await account.send("user-a", { to: ["ana@empresa.test"], body: "Aprovado.", inReplyTo: "m1" });
	assert.deepEqual(sent, { messageId: "sent-1", threadId: "thr-1", to: ["ana@empresa.test"], subject: "Re: Orçamento" });
	assert.ok(calls.some((c) => c.url.endsWith("/messages/send") && c.method === "POST"));
	await assert.rejects(account.send("user-a", { to: ["a@b.test"], body: "oi" }), /needs a subject/);
});

test("Gmail: sem o escopo de envio (403) a falha é honesta, com a dica de reconectar e o rascunho; leitura 403 não promete envio", async () => {
	const { deps } = gmailRig({ failWith: new GoogleStatusError(403, "HTTP 403: Request had insufficient authentication scopes.") });
	const account = (await createV4Email({ scope: scope(), deps }).accounts.open("user-a", "gmail"))!;
	await assert.rejects(account.send("user-a", { to: ["a@b.test"], subject: "s", body: "oi" }), (e: Error) => /does not have permission to send/.test(e.message) && /reconnect Gmail in Apps/.test(e.message) && /email_draft/.test(e.message));
	await assert.rejects(account.list("user-a", { limit: 5 }), (e: Error) => /missing a permission/.test(e.message) && !/email_draft/.test(e.message));
});

test("vazamento: o token do dono nunca aparece em erro, nem quando o Google o repete na mensagem", async () => {
	for (const failWith of [
		Object.assign(new Error(`falha com ${TOKEN}`), {}),
		new GoogleStatusError(500, `HTTP 500: Bearer ${TOKEN} inválido`),
		new GoogleStatusError(403, `HTTP 403: forbidden ${TOKEN}`),
		new (class UnauthorizedError extends Error {})(`HTTP 401: ${TOKEN}`),
	]) {
		const { deps } = gmailRig({ failWith });
		const account = (await createV4Email({ scope: scope(), deps }).accounts.open("user-a", "gmail"))!;
		for (const run of [() => account.list("user-a", { limit: 5 }), () => account.read("user-a", "m1"), () => account.send("user-a", { to: ["a@b.test"], subject: "s", body: "oi" })]) {
			await assert.rejects(run(), (e: Error) => !e.message.includes(TOKEN) && !e.message.includes("ya29"));
		}
	}
	// A função pura também redige.
	assert.ok(!gmailErrorMessage(new Error(`x ${TOKEN}`), "read", TOKEN).includes(TOKEN));
	assert.match(gmailErrorMessage(new (class UnauthorizedError extends Error {})("401"), "read"), /reconnect Gmail in Apps/);
});

// ---------------------------------------------------------------- caixa do bot

function botRig(over: { daily?: boolean } = {}) {
	const delivered: Array<{ to: string; subject: string; threadId?: string }> = [];
	const mailbox = { id: "mb", botId: "bot-1", userId: "user-a", address: "bot@openmail.test", enabled: true, allowedSenders: [], dailySendLimit: 2 } as unknown as BotMailboxRecord;
	const msgs = [
		{ id: "p1", threadId: "t1", direction: "in" as const, from: "cliente@fora.test", to: ["bot@openmail.test"], subject: "Dúvida de preço", body: "Qual o preço do plano anual?", createdAt: "2026-11-07T10:00:00Z" },
		{ id: "p2", threadId: "t1", direction: "in" as const, from: "cliente@fora.test", to: ["bot@openmail.test"], subject: "Re: Dúvida de preço", body: "Ainda aguardo.", createdAt: "2026-11-07T12:00:00Z" },
		{ id: "p3", threadId: "t2", direction: "in" as const, from: "parceiro@outro.test", to: ["bot@openmail.test"], subject: "Proposta", body: "Segue proposta.", createdAt: "2026-11-05T09:00:00Z" },
	];
	const service: V4BotMailService = {
		listFromProvider: async () => msgs,
		readThread: async (_m, threadId) => {
			if (threadId !== "t1") throw Object.assign(new Error("Thread não encontrada nesta caixa."), { code: "no_thread" });
			return { threadId: "t1", subject: "Dúvida de preço", messages: msgs.filter((m) => m.threadId === "t1") };
		},
		prepareSend: async (request) => {
			if (request.threadId === "t1") return { to: "cliente@fora.test", subject: "Re: Dúvida de preço", body: request.body, threadId: "t1", newRecipient: false };
			if (request.threadId) throw Object.assign(new Error("Thread não encontrada"), { code: "no_thread" });
			return { to: request.to!.toLowerCase(), subject: request.subject!, body: request.body, newRecipient: true };
		},
		deliver: async ({ prepared }) => {
			if (over.daily) throw Object.assign(new Error("Limite diário de 2 e-mails atingido."), { code: "daily_limit" });
			delivered.push({ to: prepared.to, subject: prepared.subject, ...(prepared.threadId && { threadId: prepared.threadId }) });
			return { threadId: prepared.threadId ?? "t9", messageId: "out-1", to: prepared.to, subject: prepared.subject };
		},
	};
	const { deps } = gmailRig({ connections: [] });
	deps.getMailbox = async (botId, userId) => (botId === "bot-1" && userId === "user-a" ? mailbox : null);
	deps.botMail = async () => service;
	return { deps, delivered };
}

test("caixa do bot: lista uma por conversa (a mais nova), filtra por remetente/assunto/período e avisa que não filtra por não lidos", async () => {
	const { deps } = botRig();
	const account = (await createV4Email({ scope: scope(), deps }).accounts.open("user-a", "bot"))!;
	const all = await account.list("user-a", { limit: 10 });
	assert.deepEqual(all.messages.map((m) => [m.id, m.subject]), [["t1", "Re: Dúvida de preço"], ["t2", "Proposta"]]);
	assert.equal(all.unsupported, undefined);
	assert.deepEqual((await account.list("user-a", { limit: 10, from: "parceiro" })).messages.map((m) => m.id), ["t2"]);
	assert.deepEqual((await account.list("user-a", { limit: 10, since: "2026-11-06" })).messages.map((m) => m.id), ["t1"]);
	assert.deepEqual((await account.list("user-a", { limit: 10, unread: true })).unsupported, ["unread"]);
	assert.equal((await account.list("user-a", { limit: 1 })).messages.length, 1);
});

test("caixa do bot: lê a conversa inteira em ordem; conversa de outra caixa é 'não encontrada'", async () => {
	const { deps } = botRig();
	const account = (await createV4Email({ scope: scope(), deps }).accounts.open("user-a", "bot"))!;
	const thread = await account.read("user-a", "t1");
	assert.match(thread.body, /Qual o preço do plano anual\?[\s\S]*Ainda aguardo\./);
	assert.equal(thread.from, "cliente@fora.test");
	await assert.rejects(account.read("user-a", "t-de-outra-caixa"), /conversation was not found/);
});

test("caixa do bot: rascunho não é guardado em lugar nenhum; resposta vai ao autor da conversa, nunca ao que o modelo inventa", async () => {
	const { deps, delivered } = botRig();
	const account = (await createV4Email({ scope: scope(), deps }).accounts.open("user-a", "bot"))!;
	assert.deepEqual(await account.createDraft("user-a", { to: ["cliente@fora.test"], body: "R$ 120", inReplyTo: "t1" }), { saved: false, to: ["cliente@fora.test"], subject: "Re: Dúvida de preço" });
	await assert.rejects(account.send("user-a", { to: ["atacante@evil.test"], body: "x", inReplyTo: "t1" }), /recipient is the person who wrote.*cliente@fora.test/);
	assert.equal(delivered.length, 0);
	await assert.rejects(account.send("user-a", { to: ["a@b.test", "c@d.test"], subject: "s", body: "x" }), /one recipient at a time/);
	assert.equal((await account.send("user-a", { to: ["cliente@fora.test"], body: "R$ 120", inReplyTo: "t1" })).messageId, "out-1");
	assert.deepEqual(delivered, [{ to: "cliente@fora.test", subject: "Re: Dúvida de preço", threadId: "t1" }]);
});

test("caixa do bot: limite diário e demais erros do serviço viram mensagem em inglês com dica, sem texto cru", async () => {
	const { deps } = botRig({ daily: true });
	const account = (await createV4Email({ scope: scope(), deps }).accounts.open("user-a", "bot"))!;
	await assert.rejects(account.send("user-a", { to: ["novo@fora.test"], subject: "Oi", body: "x" }), /daily send limit.*raised in the bot's E-mail settings/);
	assert.match(botMailErrorMessage({ code: "no_thread" }), /not found/);
	assert.match(botMailErrorMessage({ code: "provider", message: "falha ghp_abcdefghijklmnopqrstuvwxyz0123456789" }), /provider failed/);
	assert.ok(!botMailErrorMessage({ code: "provider", message: "chave ghp_abcdefghijklmnopqrstuvwxyz0123456789" }).includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
});

// ---------------------------------------------------------------- cartões

test("cartões: gravados na conversa e emitidos uma vez por identidade; falha ao gravar não derruba nem some o cartão ao vivo", async () => {
	const persisted: string[] = [];
	const emitted: ComputerUseEvent[] = [];
	const logs: string[] = [];
	const { deps } = gmailRig();
	deps.persistCard = async (conversationId, event) => {
		persisted.push(`${conversationId}:${event.type}`);
		if (event.type === "email_draft") throw new Error("db fora");
	};
	const ports = createV4Email({ scope: scope({ emit: (e: ComputerUseEvent) => void emitted.push(e), log: (m: string) => void logs.push(m) }), deps });
	const triage = { cardId: "run-1:email-triage:x", items: [{ id: "m1", category: "needs_action" as const, summary: "Aprovar" }] };
	await ports.cards.showTriage("user-a", "run-1", triage);
	await ports.cards.showTriage("user-a", "run-1", triage);
	await ports.cards.showDraft("user-a", "run-1", { cardId: "run-1:email-draft:y", source: "gmail", to: ["a@b.test"], subject: "s", body: "b", saved: true });
	assert.deepEqual(emitted.map((e) => e.type), ["email_triage", "email_draft"]);
	assert.deepEqual(persisted, ["conv-1:email_triage", "conv-1:email_draft"]);
	assert.equal(logs.length, 1);
	assert.ok(!logs[0]!.includes("a@b.test"));
});
