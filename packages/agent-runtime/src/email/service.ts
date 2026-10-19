import { randomUUID } from "node:crypto";
import {
	countSentLast24h,
	createMailbox,
	deleteMailbox,
	deleteProviderConnection,
	getMailboxForBot,
	getProviderConnection,
	hashWebhookToken,
	isGithubHookUrlPublic,
	newWebhookToken,
	recordEmailMessage,
	saveProviderConnection,
	threadReplyTarget,
	updateMailboxSettings,
	type BotMailboxRecord,
	type EmailMessageRecord,
	type ProviderConnectionRecord,
	type ProviderConnectionUpdate,
} from "@workspace/db";
import {
	EMAIL_BODY_MAX_CHARS,
	EMAIL_SUBJECT_MAX_CHARS,
	isAddressAllowed,
	normalizeEmailAddress,
	oneLineHeader,
	replySubject,
	type EmailAccountStatus,
} from "@workspace/shared";
import { SecretBoxError, isSecretBoxConfigured, openSecrets, sealSecrets } from "../mcp/secret-box.js";
import { normalizeApiKey } from "../providers/api-key-service.js";
import { createOpenMailProvider } from "./openmail.js";
import { EmailProviderError, type EmailCredentials, type EmailProvider } from "./provider.js";

/** Linha de `ProviderConnection` que guarda a chave do provedor de e-mail da conta. */
export const EMAIL_KEY_CONNECTION = "openmail";

export class EmailServiceError extends Error {
	constructor(
		readonly code:
			| "not_configured"
			| "vault_unavailable"
			| "invalid_key"
			| "no_public_url"
			| "already_enabled"
			| "not_enabled"
			| "disabled"
			| "daily_limit"
			| "bad_recipient"
			| "bad_content"
			| "no_thread"
			| "provider",
		message: string,
	) {
		super(message);
		this.name = "EmailServiceError";
	}
}

type MailboxSecrets = { webhookSecret?: string };

export type EmailStore = {
	getKeyRow(userId: string): Promise<ProviderConnectionRecord | null>;
	saveKeyRow(userId: string, data: ProviderConnectionUpdate): Promise<unknown>;
	deleteKeyRow(userId: string): Promise<unknown>;
	getMailbox: typeof getMailboxForBot;
	createMailbox: typeof createMailbox;
	updateMailbox: typeof updateMailboxSettings;
	deleteMailbox: typeof deleteMailbox;
	countSent: typeof countSentLast24h;
	record: typeof recordEmailMessage;
	replyTarget: typeof threadReplyTarget;
};

const databaseStore: EmailStore = {
	getKeyRow: (userId) => getProviderConnection(userId, EMAIL_KEY_CONNECTION),
	saveKeyRow: (userId, data) => saveProviderConnection(userId, EMAIL_KEY_CONNECTION, data),
	deleteKeyRow: (userId) => deleteProviderConnection(userId, EMAIL_KEY_CONNECTION),
	getMailbox: getMailboxForBot,
	createMailbox,
	updateMailbox: updateMailboxSettings,
	deleteMailbox,
	countSent: countSentLast24h,
	record: recordEmailMessage,
	replyTarget: threadReplyTarget,
};

export type EmailServiceDeps = {
	provider?: EmailProvider;
	store?: EmailStore;
	env?: NodeJS.ProcessEnv;
	vaultReady?: () => boolean;
	/** URL pública da API (sem barra final); padrão: ATLAS_PUBLIC_URL / ATLAS_URL. */
	publicBaseUrl?: () => string | null;
	now?: () => Date;
};

function defaultPublicBaseUrl(env: NodeJS.ProcessEnv): string | null {
	if (!isGithubHookUrlPublic()) return null;
	const raw = env.ATLAS_PUBLIC_URL?.trim() || env.ATLAS_URL?.trim();
	return raw ? raw.replace(/\/$/, "") : null;
}

export type SendRequest = {
	mailbox: BotMailboxRecord;
	/** Resposta numa thread: o destinatário vem do remetente da thread, nunca do modelo. */
	threadId?: string;
	to?: string;
	subject?: string;
	body: string;
	bodyHtml?: string;
	idempotencyKey?: string;
};

export type PreparedSend = {
	to: string;
	subject: string;
	body: string;
	bodyHtml?: string;
	threadId?: string;
	/** Destinatário fora da lista de permitidos: exige confirmação mesmo no Autônomo. */
	newRecipient: boolean;
};

export function createEmailService(deps: EmailServiceDeps = {}) {
	const env = deps.env ?? process.env;
	const provider = deps.provider ?? createOpenMailProvider();
	const store = deps.store ?? databaseStore;
	const vaultReady = deps.vaultReady ?? (() => isSecretBoxConfigured(env));
	const publicBaseUrl = deps.publicBaseUrl ?? (() => defaultPublicBaseUrl(env));
	const now = deps.now ?? (() => new Date());

	function openKey(row: ProviderConnectionRecord | null): string | null {
		if (!row?.secretsEnc || row.status !== "connected") return null;
		try {
			const secrets = openSecrets<{ apiKey?: string }>(row.secretsEnc);
			return typeof secrets.apiKey === "string" && secrets.apiKey ? secrets.apiKey : null;
		} catch (error) {
			if (error instanceof SecretBoxError) return null;
			throw error;
		}
	}

	async function credentialsFor(userId: string): Promise<{ credentials: EmailCredentials; source: "account" | "server" } | null> {
		const accountKey = openKey(await store.getKeyRow(userId));
		if (accountKey) return { credentials: { apiKey: accountKey }, source: "account" };
		const serverKey = env.OPENMAIL_API_KEY?.trim();
		return serverKey ? { credentials: { apiKey: serverKey }, source: "server" } : null;
	}

	async function requireCredentials(userId: string): Promise<EmailCredentials> {
		const resolved = await credentialsFor(userId);
		if (!resolved) throw new EmailServiceError("not_configured", "Cadastre a chave do OpenMail em Configurações para ativar o e-mail do bot.");
		return resolved.credentials;
	}

	function wrapProvider(error: unknown): never {
		if (error instanceof EmailProviderError) throw new EmailServiceError("provider", error.message);
		throw error;
	}

	return {
		provider,
		vaultReady,

		async accountStatus(userId: string): Promise<EmailAccountStatus> {
			const resolved = await credentialsFor(userId);
			return { provider: "openmail", configured: resolved !== null, source: resolved?.source ?? null, vaultReady: vaultReady() };
		},

		async saveAccountKey(userId: string, rawKey: unknown): Promise<void> {
			const apiKey = normalizeApiKey(rawKey);
			if (!apiKey) throw new EmailServiceError("invalid_key", "Informe uma chave válida do OpenMail.");
			if (!vaultReady()) throw new EmailServiceError("vault_unavailable", "Defina CONNECTOR_ENCRYPTION_KEY no .env da API e do worker.");
			await store.saveKeyRow(userId, { status: "connected", secretsEnc: sealSecrets({ apiKey }), lastError: null });
		},

		async removeAccountKey(userId: string): Promise<void> {
			await store.deleteKeyRow(userId);
		},

		/** Cria a caixa do bot no provedor, registra o webhook (URL com token + assinatura) e grava o registro. */
		async enableForBot(input: { userId: string; botId: string; botName: string; mailboxName?: string }): Promise<BotMailboxRecord> {
			if (await store.getMailbox(input.botId, input.userId)) throw new EmailServiceError("already_enabled", "Este bot já tem um endereço de e-mail.");
			const credentials = await requireCredentials(input.userId);
			if (!vaultReady()) throw new EmailServiceError("vault_unavailable", "Defina CONNECTOR_ENCRYPTION_KEY no .env da API e do worker.");
			const base = publicBaseUrl();
			if (!base) throw new EmailServiceError("no_public_url", "Defina ATLAS_PUBLIC_URL com o endereço público do servidor para receber e-mails.");
			const id = randomUUID();
			const { token, hash } = newWebhookToken();
			const webhookUrl = `${base}/v1/email/inbound/${id}?t=${token}`;
			let inbox;
			try {
				inbox = await provider.createInbox(credentials, { displayName: input.botName, nameHint: input.botName, webhookUrl, ...(input.mailboxName ? { mailboxName: input.mailboxName } : {}) });
			} catch (error) {
				wrapProvider(error);
			}
			let secret = inbox.webhookSecret;
			try {
				if (!secret) secret = await provider.rotateWebhookSecret(credentials, inbox.inboxId);
				return await store.createMailbox({
					id,
					botId: input.botId,
					userId: input.userId,
					provider: provider.id,
					address: inbox.address,
					providerInboxId: inbox.inboxId,
					secretsEnc: sealSecrets<MailboxSecrets>({ webhookSecret: secret }),
					webhookSecretHash: hash,
				});
			} catch (error) {
				// Não deixa uma caixa órfã (e cobrável) no provedor.
				await provider.deleteInbox(credentials, inbox.inboxId).catch(() => undefined);
				if (error instanceof EmailProviderError) wrapProvider(error);
				throw error;
			}
		},

		async disableForBot(input: { userId: string; botId: string }): Promise<boolean> {
			const mailbox = await store.getMailbox(input.botId, input.userId);
			if (!mailbox) return false;
			const resolved = await credentialsFor(input.userId);
			if (resolved) await provider.deleteInbox(resolved.credentials, mailbox.providerInboxId).catch(() => undefined);
			return store.deleteMailbox(input.botId, input.userId);
		},

		/** Segredo de assinatura do webhook desta caixa (decifrado só para verificar a entrega). */
		webhookSecretOf(mailbox: Pick<BotMailboxRecord, "secretsEnc">): string | null {
			if (!mailbox.secretsEnc) return null;
			try {
				return openSecrets<MailboxSecrets>(mailbox.secretsEnc).webhookSecret ?? null;
			} catch {
				return null;
			}
		},

		/**
		 * Valida destinatário, assunto e corpo e devolve o que será enviado. Não envia nem confirma.
		 * Resposta (`threadId`): o destinatário é o remetente da thread.
		 */
		async prepareSend(request: SendRequest): Promise<PreparedSend> {
			const { mailbox } = request;
			if (!mailbox.enabled) throw new EmailServiceError("disabled", "O e-mail deste bot está desativado.");
			const body = request.body.trim();
			if (!body) throw new EmailServiceError("bad_content", "O corpo do e-mail está vazio.");
			if (body.length > EMAIL_BODY_MAX_CHARS) throw new EmailServiceError("bad_content", `Corpo longo demais (máx. ${EMAIL_BODY_MAX_CHARS} caracteres).`);
			let to: string | null;
			let subject: string;
			if (request.threadId) {
				const target = await store.replyTarget(mailbox.id, request.threadId);
				if (!target) throw new EmailServiceError("no_thread", "Thread não encontrada nesta caixa. Use email_list para ver as threads.");
				to = target.to;
				subject = replySubject(target.subject);
			} else {
				to = normalizeEmailAddress(request.to);
				if (!to) throw new EmailServiceError("bad_recipient", "Destinatário inválido.");
				subject = oneLineHeader(request.subject ?? "", EMAIL_SUBJECT_MAX_CHARS);
				if (!subject) throw new EmailServiceError("bad_content", "Informe o assunto.");
			}
			if (to === normalizeEmailAddress(mailbox.address)) throw new EmailServiceError("bad_recipient", "Não envie e-mail para o próprio endereço do bot.");
			return {
				to,
				subject,
				body,
				...(request.bodyHtml?.trim() ? { bodyHtml: request.bodyHtml.trim().slice(0, EMAIL_BODY_MAX_CHARS * 2) } : {}),
				...(request.threadId ? { threadId: request.threadId } : {}),
				newRecipient: !isAddressAllowed(mailbox.allowedSenders, to),
			};
		},

		/** Quanto ainda cabe no limite diário (janela de 24 h). */
		async remainingToday(mailbox: BotMailboxRecord): Promise<number> {
			return Math.max(0, mailbox.dailySendLimit - (await store.countSent(mailbox.id, now())));
		},

		/** Envia de fato (depois de autonomia/confirmação): confere o limite, envia e registra. */
		async deliver(input: { mailbox: BotMailboxRecord; prepared: PreparedSend; idempotencyKey?: string }): Promise<{ threadId: string; messageId: string; to: string; subject: string }> {
			const { mailbox, prepared } = input;
			if (!mailbox.enabled) throw new EmailServiceError("disabled", "O e-mail deste bot está desativado.");
			if ((await store.countSent(mailbox.id, now())) >= mailbox.dailySendLimit) {
				throw new EmailServiceError("daily_limit", `Limite diário de ${mailbox.dailySendLimit} e-mails atingido. Ajuste na aba E-mail do bot.`);
			}
			const credentials = await requireCredentials(mailbox.userId);
			let result;
			try {
				result = await provider.send(credentials, {
					inboxId: mailbox.providerInboxId,
					to: prepared.to,
					subject: prepared.subject,
					body: prepared.body,
					...(prepared.bodyHtml ? { bodyHtml: prepared.bodyHtml } : {}),
					...(prepared.threadId ? { threadId: prepared.threadId } : {}),
					...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
				});
			} catch (error) {
				wrapProvider(error);
			}
			const threadId = result.threadId || prepared.threadId || result.messageId;
			await store.record({
				mailbox,
				direction: "out",
				providerMessageId: result.messageId || `out-${randomUUID()}`,
				threadId,
				from: mailbox.address,
				to: [prepared.to],
				subject: prepared.subject,
				body: prepared.body,
				status: result.status === "failed" ? "failed" : "sent",
			});
			if (result.status === "failed") throw new EmailServiceError("provider", "O OpenMail não conseguiu entregar o e-mail.");
			return { threadId, messageId: result.messageId, to: prepared.to, subject: prepared.subject };
		},

		async listFromProvider(mailbox: BotMailboxRecord, options: { limit?: number; direction?: "in" | "out" } = {}) {
			const credentials = await requireCredentials(mailbox.userId);
			try {
				return await provider.listMessages(credentials, mailbox.providerInboxId, options);
			} catch (error) {
				return wrapProvider(error);
			}
		},

		async readThread(mailbox: BotMailboxRecord, threadId: string) {
			const credentials = await requireCredentials(mailbox.userId);
			try {
				const thread = await provider.getThread(credentials, threadId);
				const own = normalizeEmailAddress(mailbox.address);
				// A thread precisa envolver esta caixa: o id de outra caixa nunca vaza o conteúdo.
				const involved = thread.messages.some((m) => normalizeEmailAddress(m.from) === own || m.to.some((t) => normalizeEmailAddress(t) === own));
				if (!involved) throw new EmailServiceError("no_thread", "Thread não encontrada nesta caixa.");
				return thread;
			} catch (error) {
				return wrapProvider(error);
			}
		},

		hashWebhookToken,
	};
}

export type EmailService = ReturnType<typeof createEmailService>;
export const emailService: EmailService = createEmailService();

export type { EmailMessageRecord };
