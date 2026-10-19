import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { Hono } = await import("hono");
const { EmailServiceError } = await import("@workspace/agent-runtime");
const { createEmailRoutes } = await import("./email.js");
const { requireUser } = await import("../middleware/auth.js");

const FAKE_KEY = "om_FAKE_KEY_NOT_REAL_12345";

type Box = { id: string; botId: string; userId: string; provider: string; address: string; allowedSenders: string[]; dailySendLimit: number; enabled: boolean; createdAt: Date; secretsEnc: string | null; providerInboxId: string; webhookSecretHash: string };

type FakeDomain = { id: string; domain: string; status: "pending" | "verified"; records: { type: "TXT" | "MX"; name: string; value: string; priority: number | null; valid: boolean }[]; verified: boolean };

function appFor(userId: string, state: { keys: Map<string, string>; boxes: Box[]; bots: Map<string, string>; domains?: FakeDomain[]; plan?: "free" | "pro" }) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", {
			session: { id: "s", userId, token: "t", expiresAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ipAddress: null, userAgent: null },
			user: { id: userId, email: `${userId}@example.com`, name: "F", emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date() },
		});
		await next();
	});
	const status = async (user: string) => ({ provider: "openmail" as const, configured: state.keys.has(user), source: state.keys.has(user) ? ("account" as const) : null, vaultReady: true });
	app.route(
		"/",
		createEmailRoutes({
			service: {
				vaultReady: () => true,
				accountStatus: status,
				saveAccountKey: async (user: string, key: unknown) => {
					if (typeof key !== "string" || key.length < 8) throw new EmailServiceError("invalid_key", "Informe uma chave válida do OpenMail.");
					state.keys.set(user, key);
				},
				removeAccountKey: async (user: string) => void state.keys.delete(user),
				listDomains: async (u: string) => {
					if (!state.keys.has(u)) throw new EmailServiceError("not_configured", "Cadastre a chave do OpenMail em Configurações para ativar o e-mail do bot.");
					return (state.domains ?? []) as never;
				},
				addDomain: async (u: string, raw: unknown) => {
					if (!state.keys.has(u)) throw new EmailServiceError("not_configured", "Cadastre a chave do OpenMail em Configurações para ativar o e-mail do bot.");
					if (typeof raw !== "string" || !raw.includes(".")) throw new EmailServiceError("invalid_domain", "Digite um domínio válido, como suaempresa.com.br.");
					if (state.plan === "free") throw new EmailServiceError("plan_required", "Domínio próprio exige um plano pago do OpenMail.");
					const row: FakeDomain = { id: `dom_${(state.domains ??= []).length + 1}`, domain: raw.toLowerCase(), status: "pending", verified: false, records: [{ type: "MX", name: raw, value: "inbound.example", priority: 10, valid: false }] };
					state.domains.push(row);
					return row as never;
				},
				verifyDomain: async (_u: string, id: string) => {
					const row = state.domains?.find((d) => d.id === id);
					if (!row) throw new EmailServiceError("invalid_domain", "Domínio não encontrado nesta conta.");
					row.status = "verified";
					row.verified = true;
					return row as never;
				},
				removeDomain: async (_u: string, id: string) => {
					const i = state.domains?.findIndex((d) => d.id === id) ?? -1;
					if (i < 0) throw new EmailServiceError("invalid_domain", "Domínio não encontrado nesta conta.");
					state.domains!.splice(i, 1);
				},
				enableForBot: async ({ userId: u, botId, domain }: { userId: string; botId: string; domain?: string }) => {
					if (domain && !state.domains?.some((d) => d.verified && d.domain === domain)) throw new EmailServiceError("invalid_domain", "Escolha um domínio verificado da sua conta.");
					if (!state.keys.has(u)) throw new EmailServiceError("not_configured", "Cadastre a chave do OpenMail em Configurações para ativar o e-mail do bot.");
					if (state.boxes.some((b) => b.botId === botId)) throw new EmailServiceError("already_enabled", "Este bot já tem um endereço de e-mail.");
					const box: Box = { id: `m_${botId}`, botId, userId: u, provider: "openmail", address: `${botId}@${domain ?? "openmail.sh"}`, allowedSenders: [], dailySendLimit: 20, enabled: true, createdAt: new Date(), secretsEnc: "v1:segredo", providerInboxId: "inb", webhookSecretHash: "hash" };
					state.boxes.push(box);
					return box as never;
				},
				disableForBot: async ({ userId: u, botId }: { userId: string; botId: string }) => {
					const i = state.boxes.findIndex((b) => b.botId === botId && b.userId === u);
					if (i >= 0) state.boxes.splice(i, 1);
					return i >= 0;
				},
			},
			getBotName: async (botId, u) => (state.bots.get(botId) === u ? "Atendente" : null),
			getMailbox: async (botId, u) => (state.boxes.find((b) => b.botId === botId && b.userId === u) as never) ?? null,
			updateMailbox: (async (botId: string, u: string, patch: Partial<Box>) => {
				const box = state.boxes.find((b) => b.botId === botId && b.userId === u);
				if (!box) return null;
				Object.assign(box, patch);
				return box;
			}) as never,
			countSent: async () => 3,
			listMessages: async () => [{ id: "e1", mailboxId: "m", userId: "u", direction: "in", providerMessageId: "p", threadId: "t", fromAddr: "ana@empresa.com", toAddrs: ["x@openmail.sh"], subject: "Oi", snippet: "oi", status: "received", conversationId: "conv", runId: null, createdAt: new Date("2026-10-18T10:00:00Z") }],
		}),
	);
	return app;
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const send = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a chave da conta entra pelo PUT e nunca volta em nenhuma resposta", async () => {
	const state = { keys: new Map<string, string>(), boxes: [] as Box[], bots: new Map([["bot_1", "user_a"]]) };
	const app = appFor("user_a", state);
	const put = await app.request("/v1/email/account", send("PUT", { apiKey: FAKE_KEY }));
	assert.equal(put.status, 200);
	const body = await put.text();
	assert.ok(!body.includes(FAKE_KEY));
	assert.deepEqual(JSON.parse(body), { provider: "openmail", configured: true, source: "account", vaultReady: true });
	assert.ok(!(await (await app.request("/v1/email/account")).text()).includes(FAKE_KEY));
	assert.equal((await app.request("/v1/email/account", send("PUT", { apiKey: "x" }))).status, 400);
	const del = await app.request("/v1/email/account", { method: "DELETE" });
	assert.equal((await del.json() as { configured: boolean }).configured, false);
});

test("sem chave: ativar devolve a instrução; com chave cria e lista as mensagens; nunca expõe segredos", async () => {
	const state = { keys: new Map<string, string>(), boxes: [] as Box[], bots: new Map([["bot_1", "user_a"]]) };
	const app = appFor("user_a", state);
	const refused = await app.request("/v1/bots/bot_1/email", json({}));
	assert.equal(refused.status, 409);
	assert.match(((await refused.json()) as { error: string }).error, /Cadastre a chave do OpenMail em Configurações/);
	state.keys.set("user_a", FAKE_KEY);
	const created = await app.request("/v1/bots/bot_1/email", json({}));
	assert.equal(created.status, 201);
	const text = await created.text();
	for (const secret of ["v1:segredo", "hash", "secretsEnc", "webhookSecretHash", FAKE_KEY]) assert.ok(!text.includes(secret), `vazou ${secret}`);
	const data = JSON.parse(text);
	assert.equal(data.mailbox.address, "bot_1@openmail.sh");
	assert.equal(data.mailbox.sentToday, 3);
	assert.equal(data.messages[0].from, "ana@empresa.com");
	assert.equal((await app.request("/v1/bots/bot_1/email", json({}))).status, 409);
});

test("isolamento por dono: outro usuário não vê, não edita, não remove nem cria no bot alheio", async () => {
	const state = { keys: new Map([["user_b", FAKE_KEY]]), boxes: [] as Box[], bots: new Map([["bot_1", "user_a"]]) };
	state.keys.set("user_a", FAKE_KEY);
	await appFor("user_a", state).request("/v1/bots/bot_1/email", json({}));
	const intruder = appFor("user_b", state);
	assert.equal((await intruder.request("/v1/bots/bot_1/email")).status, 404);
	assert.equal((await intruder.request("/v1/bots/bot_1/email", json({}))).status, 404);
	assert.equal((await intruder.request("/v1/bots/bot_1/email", send("PATCH", { allowedSenders: ["x@y.com"] }))).status, 404);
	assert.equal((await intruder.request("/v1/bots/bot_1/email", { method: "DELETE" })).status, 404);
	assert.equal((await intruder.request("/v1/bots/bot_1/email/messages")).status, 404);
	assert.equal(state.boxes.length, 1);
});

test("editar permitidos e limite valida e normaliza; desativar remove", async () => {
	const state = { keys: new Map([["user_a", FAKE_KEY]]), boxes: [] as Box[], bots: new Map([["bot_1", "user_a"]]) };
	const app = appFor("user_a", state);
	await app.request("/v1/bots/bot_1/email", json({}));
	const ok = await app.request("/v1/bots/bot_1/email", send("PATCH", { allowedSenders: ["Ana@Empresa.com", "@parceiro.com", "ana@empresa.com"], dailySendLimit: 5, enabled: false }));
	assert.equal(ok.status, 200);
	assert.deepEqual(state.boxes[0]!.allowedSenders, ["ana@empresa.com", "@parceiro.com"]);
	assert.equal(state.boxes[0]!.dailySendLimit, 5);
	assert.equal(state.boxes[0]!.enabled, false);
	assert.equal((await app.request("/v1/bots/bot_1/email", send("PATCH", { allowedSenders: ["lixo"] }))).status, 400);
	assert.equal((await app.request("/v1/bots/bot_1/email", send("PATCH", { dailySendLimit: -1 }))).status, 400);
	assert.equal((await app.request("/v1/bots/bot_1/email", send("PATCH", { dailySendLimit: 100000 }))).status, 400);
	assert.equal((await app.request("/v1/bots/bot_1/email", send("PATCH", { enabled: "sim" }))).status, 400);
	const del = await app.request("/v1/bots/bot_1/email", { method: "DELETE" });
	assert.equal(del.status, 200);
	assert.equal(state.boxes.length, 0);
});

test("a entrada de e-mail é pública (sem sessão) e o resto de /v1/email continua exigindo sessão", async () => {
	const app = new Hono();
	app.use("/v1/*", requireUser);
	app.post("/v1/email/inbound/:id", (c) => c.json({ reached: true }));
	app.get("/v1/email/account", (c) => c.json({ reached: true }));
	const open = await app.request("/v1/email/inbound/mbx_1?t=abc", { method: "POST", body: "{}" });
	assert.equal(open.status, 200);
	const closed = await app.request("/v1/email/account");
	assert.equal(closed.status, 401);
});

test("domínios próprios: listar, adicionar (com DNS), verificar e remover; erros com mensagem fixa e sem a chave", async () => {
	const state = { keys: new Map([["user_a", FAKE_KEY]]), boxes: [] as Box[], bots: new Map([["bot_1", "user_a"]]), domains: [] as FakeDomain[] };
	const app = appFor("user_a", state);
	assert.deepEqual(await (await app.request("/v1/email/domains")).json(), { domains: [] });
	const added = await app.request("/v1/email/domains", json({ domain: "suaempresa.com.br" }));
	assert.equal(added.status, 201);
	const body = (await added.json()) as { domain: FakeDomain };
	assert.equal(body.domain.status, "pending");
	assert.equal(body.domain.records[0]!.type, "MX");
	assert.equal((await app.request("/v1/email/domains", json({ domain: "lixo" }))).status, 422);
	const verified = await app.request(`/v1/email/domains/${body.domain.id}/verify`, { method: "POST" });
	assert.equal(((await verified.json()) as { domain: FakeDomain }).domain.verified, true);
	assert.equal((await app.request("/v1/email/domains/dom_x/verify", { method: "POST" })).status, 422);
	assert.equal((await app.request(`/v1/email/domains/${body.domain.id}`, { method: "DELETE" })).status, 200);
	assert.equal(state.domains.length, 0);
	const text = JSON.stringify(await (await app.request("/v1/email/domains")).json());
	assert.ok(!text.includes(FAKE_KEY));
});

test("domínios: sem a chave 409, plano gratuito 402 com mensagem fixa", async () => {
	const none = appFor("user_a", { keys: new Map(), boxes: [], bots: new Map(), domains: [] });
	assert.equal((await none.request("/v1/email/domains")).status, 409);
	const free = appFor("user_a", { keys: new Map([["user_a", FAKE_KEY]]), boxes: [], bots: new Map(), domains: [], plan: "free" });
	const res = await free.request("/v1/email/domains", json({ domain: "suaempresa.com.br" }));
	assert.equal(res.status, 402);
	assert.deepEqual(await res.json(), { error: "Domínio próprio exige um plano pago do OpenMail.", code: "plan_required" });
});

test("criar o endereço num domínio: só vale se estiver verificado na conta", async () => {
	const state = { keys: new Map([["user_a", FAKE_KEY]]), boxes: [] as Box[], bots: new Map([["bot_1", "user_a"]]), domains: [{ id: "dom_1", domain: "suaempresa.com.br", status: "verified", verified: true, records: [] }, { id: "dom_2", domain: "pendente.com", status: "pending", verified: false, records: [] }] as FakeDomain[] };
	const app = appFor("user_a", state);
	assert.equal((await app.request("/v1/bots/bot_1/email", json({ domain: "pendente.com" }))).status, 422);
	assert.equal((await app.request("/v1/bots/bot_1/email", json({ domain: "naoexiste.com" }))).status, 422);
	assert.equal(state.boxes.length, 0);
	const ok = await app.request("/v1/bots/bot_1/email", json({ domain: "suaempresa.com.br" }));
	assert.equal(ok.status, 201);
	assert.equal(state.boxes[0]!.address, "bot_1@suaempresa.com.br");
});

test("remetentes permitidos aceitam até 1000 entradas e recusam acima", async () => {
	const state = { keys: new Map([["user_a", FAKE_KEY]]), boxes: [] as Box[], bots: new Map([["bot_1", "user_a"]]) };
	const app = appFor("user_a", state);
	await app.request("/v1/bots/bot_1/email", json({}));
	const many = (n: number) => Array.from({ length: n }, (_, i) => `pessoa${i}@empresa.com`);
	assert.equal((await app.request("/v1/bots/bot_1/email", send("PATCH", { allowedSenders: many(1000) }))).status, 200);
	assert.equal(state.boxes[0]!.allowedSenders.length, 1000);
	assert.equal((await app.request("/v1/bots/bot_1/email", send("PATCH", { allowedSenders: many(1001) }))).status, 400);
});
