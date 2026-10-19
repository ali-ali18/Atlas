import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { executeConfirmedEmailSend, executeConfirmedEmailKey, executeConfirmedMailboxCreate } = await import("./confirmed-action.js");
const { EmailServiceError } = await import("@workspace/agent-runtime");

const mailbox = { id: "mbx_1", botId: "bot_1", userId: "user_a", address: "bot@openmail.sh" };
const payload = (over: Record<string, unknown> = {}) =>
	({
		kind: "confirm",
		action: "email-send",
		confirmId: "confirm-email-run1-abcd1234",
		botId: "bot_1",
		emailSend: { mailboxId: "mbx_1", to: "ana@empresa.com", subject: "Re: Cotação", body: "Segue o preço.", threadId: "thr_1" },
		...over,
	}) as never;

function deps(over: { mailbox?: typeof mailbox | null; deliverError?: Error } = {}) {
	const calls: Array<Record<string, unknown>> = [];
	return {
		calls,
		deps: {
			getMailbox: (async (botId: string, userId: string) => {
				const box = over.mailbox === undefined ? mailbox : over.mailbox;
				return box && box.botId === botId && box.userId === userId ? box : null;
			}) as never,
			service: {
				prepareSend: async (req: Record<string, unknown>) => ({ to: String(req.to), subject: String(req.subject), body: String(req.body), threadId: req.threadId, newRecipient: false }),
				deliver: async (input: Record<string, unknown>) => {
					if (over.deliverError) throw over.deliverError;
					calls.push(input);
					const prepared = input.prepared as { to: string; subject: string };
					return { threadId: "thr_1", messageId: "m1", to: prepared.to, subject: prepared.subject };
				},
			} as never,
		},
	};
}

test("aprovado: envia exatamente o que o cartão mostrou, com a chave de idempotência do cartão", async () => {
	const { deps: d, calls } = deps();
	const out = await executeConfirmedEmailSend({ userId: "user_a", botId: "bot_1", payload: payload() }, d);
	assert.equal(out.ok, true);
	assert.match(out.text, /E-mail enviado para ana@empresa\.com/);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.idempotencyKey, "confirm-email-run1-abcd1234");
	assert.deepEqual({ to: (calls[0]!.prepared as { to: string }).to, subject: (calls[0]!.prepared as { subject: string }).subject }, { to: "ana@empresa.com", subject: "Re: Cotação" });
});

test("confirmação de outro bot, de outro dono ou de caixa trocada não envia nada", async () => {
	const a = deps();
	assert.equal((await executeConfirmedEmailSend({ userId: "user_a", botId: "bot_2", payload: payload() }, a.deps)).ok, false);
	const b = deps();
	assert.equal((await executeConfirmedEmailSend({ userId: "user_b", botId: "bot_1", payload: payload() }, b.deps)).ok, false);
	const c = deps();
	assert.equal((await executeConfirmedEmailSend({ userId: "user_a", botId: "bot_1", payload: payload({ emailSend: { mailboxId: "mbx_outra", to: "x@y.com", subject: "s", body: "b" } }) }, c.deps)).ok, false);
	const d = deps({ mailbox: null });
	assert.equal((await executeConfirmedEmailSend({ userId: "user_a", botId: "bot_1", payload: payload() }, d.deps)).ok, false);
	assert.equal(a.calls.length + b.calls.length + c.calls.length + d.calls.length, 0);
});

test("falha do provedor ou limite diário viram mensagem limpa, sem enviar", async () => {
	const limit = deps({ deliverError: new EmailServiceError("daily_limit", "Limite diário de 20 e-mails atingido.") });
	const out = await executeConfirmedEmailSend({ userId: "user_a", botId: "bot_1", payload: payload() }, limit.deps);
	assert.equal(out.ok, false);
	assert.match(out.text, /Limite diário de 20/);
	const boom = deps({ deliverError: new Error("socket hang up chave=om_SEGREDO") });
	const out2 = await executeConfirmedEmailSend({ userId: "user_a", botId: "bot_1", payload: payload() }, boom.deps);
	assert.equal(out2.ok, false);
	assert.ok(!out2.text.includes("om_SEGREDO"));
});

const createPayload = (over: Record<string, unknown> = {}) =>
	({ kind: "confirm", action: "email-create-mailbox", confirmId: "confirm-emailbox-run1", botId: "bot_1", emailCreate: { mailboxName: "atendente-ab12cd" }, ...over }) as never;

test("criar e-mail confirmado: usa o serviço da rota com o nome do cartão, só para o bot do cartão", async () => {
	const calls: Array<Record<string, unknown>> = [];
	const deps = {
		getBotName: async (botId: string, userId: string) => (botId === "bot_1" && userId === "user_a" ? "Atendente" : null),
		service: { enableForBot: async (input: Record<string, unknown>) => (calls.push(input), { address: "atendente-ab12cd@openmail.sh" }) } as never,
	};
	const ok = await executeConfirmedMailboxCreate({ userId: "user_a", botId: "bot_1", payload: createPayload() }, deps);
	assert.equal(ok.ok, true);
	assert.deepEqual(calls[0], { userId: "user_a", botId: "bot_1", botName: "Atendente", mailboxName: "atendente-ab12cd" });
	assert.match(ok.followUp, /atendente-ab12cd@openmail.sh/);
	assert.match(ok.followUp, /aba E-mail/);
	// outro bot no cartão, outro dono ou cartão sem dados: nada é criado
	assert.equal((await executeConfirmedMailboxCreate({ userId: "user_a", botId: "bot_2", payload: createPayload() }, deps)).ok, false);
	assert.equal((await executeConfirmedMailboxCreate({ userId: "user_b", botId: "bot_1", payload: createPayload() }, deps)).ok, false);
	assert.equal((await executeConfirmedMailboxCreate({ userId: "user_a", botId: "bot_1", payload: createPayload({ emailCreate: undefined }) }, deps)).ok, false);
	assert.equal(calls.length, 1);
});

test("criar e-mail confirmado: erro do provedor vira mensagem limpa", async () => {
	const deps = {
		getBotName: async () => "Atendente",
		service: { enableForBot: async () => { throw new EmailServiceError("already_enabled", "Este bot já tem um endereço de e-mail."); } } as never,
	};
	const out = await executeConfirmedMailboxCreate({ userId: "user_a", botId: "bot_1", payload: createPayload() }, deps);
	assert.equal(out.ok, false);
	assert.match(out.text, /já tem um endereço/);
});

test("cartão de chave: só confere se ficou salva (nunca recebe nem devolve o valor)", async () => {
	const saved = await executeConfirmedEmailKey({ userId: "user_a" }, { accountStatus: async () => ({ configured: true }) });
	assert.equal(saved.ok, true);
	assert.equal(saved.detail, "Chave salva");
	const missing = await executeConfirmedEmailKey({ userId: "user_a" }, { accountStatus: async () => ({ configured: false }) });
	assert.equal(missing.ok, false);
	assert.match(missing.followUp, /não peça a chave no chat/);
	const broken = await executeConfirmedEmailKey({ userId: "user_a" }, { accountStatus: async () => { throw new Error("db"); } });
	assert.equal(broken.ok, false);
});
