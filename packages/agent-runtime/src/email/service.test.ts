import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BotMailboxRecord, EmailMessageRecord, ProviderConnectionRecord } from "@workspace/db";
import { openSecrets } from "../mcp/secret-box.js";
import { EmailServiceError, createEmailService, type EmailStore } from "./service.js";
import { EmailProviderError, type EmailProvider } from "./provider.js";

beforeAll(() => {
	process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

const FAKE_KEY = "om_FAKE_KEY_NOT_REAL_12345";

function mailbox(over: Partial<BotMailboxRecord> = {}): BotMailboxRecord {
	return {
		id: "mbx_1", botId: "bot_1", userId: "user_a", provider: "openmail", address: "bot@openmail.sh", providerInboxId: "inb_1",
		secretsEnc: null, webhookSecretHash: "h", allowedSenders: ["ana@empresa.com"], dailySendLimit: 2, enabled: true, createdAt: new Date(), ...over,
	};
}

function fakeStore(initial: { mailboxes?: BotMailboxRecord[]; sent?: number } = {}) {
	const keys = new Map<string, Partial<ProviderConnectionRecord>>();
	const boxes = [...(initial.mailboxes ?? [])];
	const recorded: unknown[] = [];
	let sent = initial.sent ?? 0;
	const store: EmailStore = {
		getKeyRow: async (userId) => (keys.get(userId) as ProviderConnectionRecord | undefined) ?? null,
		saveKeyRow: async (userId, data) => void keys.set(userId, { ...(keys.get(userId) ?? {}), ...data }),
		deleteKeyRow: async (userId) => void keys.delete(userId),
		getMailbox: async (botId, userId) => boxes.find((b) => b.botId === botId && b.userId === userId) ?? null,
		createMailbox: async (input) => {
			const row = mailbox({ id: input.id ?? "new", botId: input.botId, userId: input.userId, address: input.address, providerInboxId: input.providerInboxId, secretsEnc: input.secretsEnc, webhookSecretHash: input.webhookSecretHash, allowedSenders: [] });
			boxes.push(row);
			return row;
		},
		updateMailbox: async () => null,
		deleteMailbox: async (botId, userId) => {
			const i = boxes.findIndex((b) => b.botId === botId && b.userId === userId);
			if (i >= 0) boxes.splice(i, 1);
			return i >= 0;
		},
		countSent: async () => sent,
		record: async (input) => {
			recorded.push(input);
			if (input.direction === "out" && input.status === "sent") sent += 1;
			return { created: true, row: {} as EmailMessageRecord };
		},
		replyTarget: async (_id, threadId) => (threadId === "thr_1" ? { to: "ana@empresa.com", subject: "Cotação" } : null),
	};
	return { store, keys, boxes, recorded };
}

function fakeProvider(over: Partial<EmailProvider> = {}): EmailProvider & { sends: unknown[]; deleted: string[] } {
	const sends: unknown[] = [];
	const deleted: string[] = [];
	return {
		id: "openmail",
		sends,
		deleted,
		createInbox: async () => ({ inboxId: "inb_new", address: "novo@openmail.sh", webhookSecret: "whsec_secret" }),
		deleteInbox: async (_c, id) => void deleted.push(id),
		rotateWebhookSecret: async () => "whsec_rot",
		send: async (_c, input) => {
			sends.push(input);
			return { messageId: `msg_${sends.length}`, threadId: input.threadId ?? "thr_new", status: "sent" };
		},
		listMessages: async () => [],
		getThread: async () => ({ threadId: "thr_1", subject: "x", messages: [] }),
		verifyAndParseWebhook: () => ({ ok: true, event: null }),
		...over,
	} as EmailProvider & { sends: unknown[]; deleted: string[] };
}

const base = { vaultReady: () => true, publicBaseUrl: () => "https://atlas.example" };
const serverEnv = { OPENMAIL_API_KEY: FAKE_KEY };

describe("chave da conta", () => {
	it("guarda cifrada, nunca devolve em claro e cai no env do servidor", async () => {
		const { store, keys } = fakeStore();
		const service = createEmailService({ ...base, store, provider: fakeProvider(), env: {} });
		expect(await service.accountStatus("user_a")).toMatchObject({ configured: false, source: null });
		await service.saveAccountKey("user_a", FAKE_KEY);
		const row = keys.get("user_a")!;
		expect(row.secretsEnc).not.toContain(FAKE_KEY);
		expect(openSecrets<{ apiKey: string }>(row.secretsEnc!).apiKey).toBe(FAKE_KEY);
		const status = await service.accountStatus("user_a");
		expect(status).toEqual({ provider: "openmail", configured: true, source: "account", vaultReady: true });
		expect(JSON.stringify(status)).not.toContain(FAKE_KEY);
		// outro dono não enxerga a chave
		expect((await service.accountStatus("user_b")).configured).toBe(false);
		// fallback do servidor
		const withEnv = createEmailService({ ...base, store: fakeStore().store, provider: fakeProvider(), env: { OPENMAIL_API_KEY: "om_server_key_123456" } });
		expect(await withEnv.accountStatus("user_b")).toMatchObject({ configured: true, source: "server" });
	});

	it("recusa chave inválida e cofre indisponível", async () => {
		const service = createEmailService({ ...base, store: fakeStore().store, provider: fakeProvider(), env: {} });
		await expect(service.saveAccountKey("user_a", "curta")).rejects.toMatchObject({ code: "invalid_key" });
		const noVault = createEmailService({ ...base, vaultReady: () => false, store: fakeStore().store, provider: fakeProvider(), env: {} });
		await expect(noVault.saveAccountKey("user_a", FAKE_KEY)).rejects.toMatchObject({ code: "vault_unavailable" });
	});
});

describe("ativar o endereço do bot", () => {
	it("cria a caixa com webhook (token na URL), cifra o segredo e grava só o hash do token", async () => {
		const { store, boxes } = fakeStore();
		const provider = fakeProvider();
		const createInbox = vi.spyOn(provider, "createInbox");
		const service = createEmailService({ ...base, store, provider, env: serverEnv });
		const created = await service.enableForBot({ userId: "user_a", botId: "bot_1", botName: "Atendente" });
		expect(created.address).toBe("novo@openmail.sh");
		const url = createInbox.mock.calls[0]![1].webhookUrl;
		expect(url).toMatch(/^https:\/\/atlas\.example\/v1\/email\/inbound\/[0-9a-f-]{36}\?t=[A-Za-z0-9_-]{20,}$/);
		const token = new URL(url).searchParams.get("t")!;
		expect(created.id).toBe(new URL(url).pathname.split("/").pop());
		expect(created.webhookSecretHash).toBe(service.hashWebhookToken(token));
		expect(created.webhookSecretHash).not.toContain(token);
		expect(created.secretsEnc).not.toContain("whsec_secret");
		expect(service.webhookSecretOf(created)).toBe("whsec_secret");
		expect(boxes).toHaveLength(1);
	});

	it("sem chave: instrução; sem URL pública: instrução; já ativo: conflito", async () => {
		const empty = createEmailService({ ...base, store: fakeStore().store, provider: fakeProvider(), env: {} });
		await expect(empty.enableForBot({ userId: "user_a", botId: "bot_1", botName: "B" })).rejects.toMatchObject({ code: "not_configured" });
		const noUrl = createEmailService({ ...base, publicBaseUrl: () => null, store: fakeStore().store, provider: fakeProvider(), env: serverEnv });
		await expect(noUrl.enableForBot({ userId: "user_a", botId: "bot_1", botName: "B" })).rejects.toMatchObject({ code: "no_public_url" });
		const dup = createEmailService({ ...base, store: fakeStore({ mailboxes: [mailbox()] }).store, provider: fakeProvider(), env: serverEnv });
		await expect(dup.enableForBot({ userId: "user_a", botId: "bot_1", botName: "B" })).rejects.toMatchObject({ code: "already_enabled" });
	});

	it("falha ao gravar apaga a caixa criada no provedor (sem órfã)", async () => {
		const { store } = fakeStore();
		store.createMailbox = async () => {
			throw new Error("db fora");
		};
		const provider = fakeProvider();
		const service = createEmailService({ ...base, store, provider, env: serverEnv });
		await expect(service.enableForBot({ userId: "user_a", botId: "bot_1", botName: "B" })).rejects.toThrow("db fora");
		expect(provider.deleted).toEqual(["inb_new"]);
	});

	it("erro do provedor vira EmailServiceError com mensagem fixa", async () => {
		const provider = fakeProvider({
			createInbox: async () => {
				throw new EmailProviderError("auth_failed", "OpenMail recusou a chave.");
			},
		});
		const service = createEmailService({ ...base, store: fakeStore().store, provider, env: serverEnv });
		await expect(service.enableForBot({ userId: "user_a", botId: "bot_1", botName: "B" })).rejects.toBeInstanceOf(EmailServiceError);
	});

	it("desativar apaga no provedor e some do banco; outro dono não consegue", async () => {
		const { store, boxes } = fakeStore({ mailboxes: [mailbox()] });
		const provider = fakeProvider();
		const service = createEmailService({ ...base, store, provider, env: serverEnv });
		expect(await service.disableForBot({ userId: "user_b", botId: "bot_1" })).toBe(false);
		expect(boxes).toHaveLength(1);
		expect(await service.disableForBot({ userId: "user_a", botId: "bot_1" })).toBe(true);
		expect(provider.deleted).toEqual(["inb_1"]);
		expect(boxes).toHaveLength(0);
	});
});

describe("preparar e enviar", () => {
	it("resposta: destinatário e assunto vêm da thread, nunca do modelo", async () => {
		const service = createEmailService({ ...base, store: fakeStore().store, provider: fakeProvider(), env: serverEnv });
		const prepared = await service.prepareSend({ mailbox: mailbox(), threadId: "thr_1", to: "atacante@evil.com", subject: "outro", body: "Segue o preço." });
		expect(prepared).toMatchObject({ to: "ana@empresa.com", subject: "Re: Cotação", threadId: "thr_1", newRecipient: false });
		await expect(service.prepareSend({ mailbox: mailbox(), threadId: "thr_inexistente", body: "x" })).rejects.toMatchObject({ code: "no_thread" });
	});

	it("destinatário fora da lista é novo; domínio permitido não é; próprio endereço e vazio são recusados", async () => {
		const service = createEmailService({ ...base, store: fakeStore().store, provider: fakeProvider(), env: serverEnv });
		const box = mailbox({ allowedSenders: ["@parceiro.com"] });
		expect((await service.prepareSend({ mailbox: box, to: "x@outro.com", subject: "Oi", body: "t" })).newRecipient).toBe(true);
		expect((await service.prepareSend({ mailbox: box, to: "Fulano <f@parceiro.com>", subject: "Oi", body: "t" })).newRecipient).toBe(false);
		await expect(service.prepareSend({ mailbox: box, to: "bot@openmail.sh", subject: "Oi", body: "t" })).rejects.toMatchObject({ code: "bad_recipient" });
		await expect(service.prepareSend({ mailbox: box, to: "não é email", subject: "Oi", body: "t" })).rejects.toMatchObject({ code: "bad_recipient" });
		await expect(service.prepareSend({ mailbox: box, to: "x@outro.com", subject: "Oi", body: "   " })).rejects.toMatchObject({ code: "bad_content" });
		await expect(service.prepareSend({ mailbox: mailbox({ enabled: false }), to: "x@outro.com", subject: "Oi", body: "t" })).rejects.toMatchObject({ code: "disabled" });
	});

	it("respeita o limite diário e registra o envio", async () => {
		const { store, recorded } = fakeStore({ sent: 1 });
		const provider = fakeProvider();
		const service = createEmailService({ ...base, store, provider, env: serverEnv });
		const box = mailbox({ dailySendLimit: 2 });
		const prepared = await service.prepareSend({ mailbox: box, to: "ana@empresa.com", subject: "Oi", body: "texto" });
		expect(await service.remainingToday(box)).toBe(1);
		const sent = await service.deliver({ mailbox: box, prepared, idempotencyKey: "k" });
		expect(sent).toMatchObject({ to: "ana@empresa.com", threadId: "thr_new" });
		expect(provider.sends[0]).toMatchObject({ idempotencyKey: "k", inboxId: "inb_1" });
		expect(recorded[0]).toMatchObject({ direction: "out", status: "sent", from: "bot@openmail.sh" });
		expect(await service.remainingToday(box)).toBe(0);
		await expect(service.deliver({ mailbox: box, prepared })).rejects.toMatchObject({ code: "daily_limit" });
		expect(provider.sends).toHaveLength(1);
	});

	it("thread de outra caixa não vaza o conteúdo", async () => {
		const provider = fakeProvider({
			getThread: async () => ({ threadId: "thr_x", subject: "s", messages: [{ id: "1", threadId: "thr_x", direction: "in", from: "a@b.co", to: ["outro@openmail.sh"], subject: "s", body: "segredo", createdAt: "" }] }),
		});
		const service = createEmailService({ ...base, store: fakeStore().store, provider, env: serverEnv });
		await expect(service.readThread(mailbox(), "thr_x")).rejects.toMatchObject({ code: "no_thread" });
	});
});

describe("domínio próprio", () => {
	const dom = (over: Record<string, unknown> = {}) => ({ id: "dom_1", domain: "suaempresa.com.br", status: "verified" as const, records: [], ...over });
	function withDomains(list: ReturnType<typeof dom>[]) {
		const provider = fakeProvider();
		const calls = { add: [] as string[], verify: [] as string[], remove: [] as string[] };
		(provider as { domains?: unknown }).domains = {
			list: async () => list,
			add: async (_c: unknown, d: string) => (calls.add.push(d), dom({ id: "dom_new", domain: d, status: "pending" })),
			verify: async (_c: unknown, id: string) => (calls.verify.push(id), dom({ id })),
			remove: async (_c: unknown, id: string) => void calls.remove.push(id),
		};
		return { provider, calls };
	}

	it("adiciona (normaliza o domínio), lista com 'verified' e só verifica/remove domínios da conta", async () => {
		const { provider, calls } = withDomains([dom(), dom({ id: "dom_2", domain: "pendente.com", status: "pending" })]);
		const service = createEmailService({ ...base, store: fakeStore().store, provider, env: serverEnv });
		const added = await service.addDomain("user_a", " @SuaEmpresa.com.br. ");
		expect(calls.add).toEqual(["suaempresa.com.br"]);
		expect(added).toMatchObject({ id: "dom_new", verified: false });
		expect((await service.listDomains("user_a")).map((d) => d.verified)).toEqual([true, false]);
		await service.verifyDomain("user_a", "dom_2");
		await service.removeDomain("user_a", "dom_2");
		expect(calls.verify).toEqual(["dom_2"]);
		expect(calls.remove).toEqual(["dom_2"]);
		await expect(service.verifyDomain("user_a", "dom_de_outro")).rejects.toMatchObject({ code: "invalid_domain" });
		await expect(service.removeDomain("user_a", "dom_de_outro")).rejects.toMatchObject({ code: "invalid_domain" });
		await expect(service.addDomain("user_a", "lixo")).rejects.toMatchObject({ code: "invalid_domain" });
	});

	it("erros do provedor viram códigos do serviço; sem chave pede configuração; provedor sem suporte avisa", async () => {
		const provider = fakeProvider();
		(provider as { domains?: unknown }).domains = { list: async () => [], add: async () => { throw new EmailProviderError("plan_required", "Domínio próprio exige um plano pago do OpenMail."); }, verify: async () => dom(), remove: async () => undefined };
		const service = createEmailService({ ...base, store: fakeStore().store, provider, env: serverEnv });
		await expect(service.addDomain("user_a", "suaempresa.com.br")).rejects.toMatchObject({ code: "plan_required" });
		const noKey = createEmailService({ ...base, store: fakeStore().store, provider, env: {} });
		await expect(noKey.listDomains("user_a")).rejects.toMatchObject({ code: "not_configured" });
		const plain = createEmailService({ ...base, store: fakeStore().store, provider: fakeProvider(), env: serverEnv });
		await expect(plain.listDomains("user_a")).rejects.toMatchObject({ code: "domains_unsupported" });
	});

	it("criar a caixa num domínio exige domínio verificado da conta e o repassa ao provedor", async () => {
		const { provider } = withDomains([dom(), dom({ id: "dom_2", domain: "pendente.com", status: "pending" })]);
		const createInbox = vi.spyOn(provider, "createInbox");
		const { store, boxes } = fakeStore();
		const service = createEmailService({ ...base, store, provider, env: serverEnv });
		await expect(service.enableForBot({ userId: "user_a", botId: "bot_1", botName: "B", domain: "pendente.com" })).rejects.toMatchObject({ code: "invalid_domain" });
		await expect(service.enableForBot({ userId: "user_a", botId: "bot_1", botName: "B", domain: "outra.com" })).rejects.toMatchObject({ code: "invalid_domain" });
		expect(createInbox).not.toHaveBeenCalled();
		expect(boxes).toHaveLength(0);
		await service.enableForBot({ userId: "user_a", botId: "bot_1", botName: "B", mailboxName: "atendimento", domain: "SuaEmpresa.com.br" });
		expect(createInbox.mock.calls[0]![1]).toMatchObject({ mailboxName: "atendimento", domain: "suaempresa.com.br" });
		expect(boxes).toHaveLength(1);
	});
});
