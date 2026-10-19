import { Hono } from "hono";
import {
	countSentLast24h,
	getMailboxForBot,
	listEmailMessages,
	prisma,
	toEmailMessageDto,
	toMailboxDto,
	updateMailboxSettings,
	type BotMailboxRecord,
	type EmailMessageRecord,
} from "@workspace/db";
import { EmailServiceError, emailService, type EmailService } from "@workspace/agent-runtime";
import {
	EMAIL_ALLOWED_SENDERS_MAX,
	clampDailySendLimit,
	normalizeAllowedSender,
	type BotMailboxDto,
	type EmailAccountStatus,
	type EmailMessageDto,
} from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

export type EmailRouteDeps = {
	service: Pick<EmailService, "accountStatus" | "saveAccountKey" | "removeAccountKey" | "enableForBot" | "disableForBot" | "vaultReady">;
	getBotName: (botId: string, userId: string) => Promise<string | null>;
	getMailbox: (botId: string, userId: string) => Promise<BotMailboxRecord | null>;
	updateMailbox: typeof updateMailboxSettings;
	countSent: (mailboxId: string) => Promise<number>;
	listMessages: (botId: string, userId: string, limit: number) => Promise<EmailMessageRecord[]>;
};

const defaultDeps: EmailRouteDeps = {
	service: emailService,
	getBotName: async (botId, userId) => (await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { name: true } }))?.name ?? null,
	getMailbox: getMailboxForBot,
	updateMailbox: updateMailboxSettings,
	countSent: (mailboxId) => countSentLast24h(mailboxId),
	listMessages: listEmailMessages,
};

const STATUS_BY_CODE: Record<EmailServiceError["code"], 400 | 404 | 409 | 422 | 502 | 503> = {
	not_configured: 409,
	vault_unavailable: 503,
	invalid_key: 400,
	no_public_url: 409,
	already_enabled: 409,
	not_enabled: 404,
	disabled: 409,
	daily_limit: 409,
	bad_recipient: 400,
	bad_content: 400,
	no_thread: 404,
	provider: 502,
};

function failure(error: unknown): { body: { error: string; code: string }; status: 400 | 404 | 409 | 422 | 502 | 503 } {
	if (error instanceof EmailServiceError) return { body: { error: error.message, code: error.code }, status: STATUS_BY_CODE[error.code] };
	return { body: { error: "Não foi possível concluir a operação. Tente novamente.", code: "upstream_error" }, status: 502 };
}

/**
 * E-mail do bot: chave do provedor na conta (write-only) e, por bot, ativar/desativar o endereço,
 * remetentes permitidos, limite diário e a lista de mensagens. Tudo escopado pelo dono da sessão.
 */
export function createEmailRoutes(deps: EmailRouteDeps = defaultDeps) {
	const app = new Hono<AuthEnv>();
	const userOf = (c: { get(key: "session"): Parameters<typeof scopeFor>[0] }) => scopeFor(c.get("session")).userId;

	async function tabPayload(botId: string, userId: string): Promise<{ account: EmailAccountStatus; mailbox: BotMailboxDto | null; messages: EmailMessageDto[] }> {
		const account = await deps.service.accountStatus(userId);
		const mailbox = await deps.getMailbox(botId, userId);
		if (!mailbox) return { account, mailbox: null, messages: [] };
		const [sent, rows] = await Promise.all([deps.countSent(mailbox.id), deps.listMessages(botId, userId, 30)]);
		return { account, mailbox: toMailboxDto(mailbox, sent), messages: rows.map(toEmailMessageDto) };
	}

	app.get("/v1/email/account", async (c) => {
		try {
			return c.json(await deps.service.accountStatus(userOf(c)));
		} catch {
			return c.json({ error: "Não foi possível carregar o provedor de e-mail" }, 503);
		}
	});

	app.put("/v1/email/account", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Corpo inválido" }, 400);
		}
		try {
			const userId = userOf(c);
			await deps.service.saveAccountKey(userId, (body as { apiKey?: unknown } | null)?.apiKey);
			return c.json(await deps.service.accountStatus(userId));
		} catch (error) {
			const f = failure(error);
			return c.json(f.body, f.status);
		}
	});

	app.delete("/v1/email/account", async (c) => {
		try {
			const userId = userOf(c);
			await deps.service.removeAccountKey(userId);
			return c.json(await deps.service.accountStatus(userId));
		} catch {
			return c.json({ error: "Não foi possível remover a chave" }, 503);
		}
	});

	app.get("/v1/bots/:botId/email", async (c) => {
		try {
			const userId = userOf(c);
			const botId = c.req.param("botId");
			if (!(await deps.getBotName(botId, userId))) return c.json({ error: "Bot não encontrado" }, 404);
			return c.json(await tabPayload(botId, userId));
		} catch {
			return c.json({ error: "Não foi possível carregar o e-mail do bot" }, 503);
		}
	});

	app.post("/v1/bots/:botId/email", async (c) => {
		try {
			const userId = userOf(c);
			const botId = c.req.param("botId");
			const name = await deps.getBotName(botId, userId);
			if (!name) return c.json({ error: "Bot não encontrado" }, 404);
			await deps.service.enableForBot({ userId, botId, botName: name });
			return c.json(await tabPayload(botId, userId), 201);
		} catch (error) {
			const f = failure(error);
			return c.json(f.body, f.status);
		}
	});

	app.patch("/v1/bots/:botId/email", async (c) => {
		let body: Record<string, unknown>;
		try {
			const parsed = await c.req.json();
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad");
			body = parsed as Record<string, unknown>;
		} catch {
			return c.json({ error: "Corpo inválido" }, 400);
		}
		const patch: { allowedSenders?: string[]; dailySendLimit?: number; enabled?: boolean } = {};
		if (body.allowedSenders !== undefined) {
			if (!Array.isArray(body.allowedSenders) || body.allowedSenders.length > EMAIL_ALLOWED_SENDERS_MAX) return c.json({ error: `Até ${EMAIL_ALLOWED_SENDERS_MAX} remetentes permitidos` }, 400);
			const rules: string[] = [];
			for (const item of body.allowedSenders) {
				const rule = normalizeAllowedSender(item);
				if (!rule) return c.json({ error: "Endereço inválido na lista de permitidos" }, 400);
				if (!rules.includes(rule)) rules.push(rule);
			}
			patch.allowedSenders = rules;
		}
		if (body.dailySendLimit !== undefined) {
			const limit = clampDailySendLimit(body.dailySendLimit);
			if (limit === null) return c.json({ error: "Limite diário inválido" }, 400);
			patch.dailySendLimit = limit;
		}
		if (body.enabled !== undefined) {
			if (typeof body.enabled !== "boolean") return c.json({ error: "Valor inválido para enabled" }, 400);
			patch.enabled = body.enabled;
		}
		try {
			const userId = userOf(c);
			const botId = c.req.param("botId");
			const updated = await deps.updateMailbox(botId, userId, patch);
			if (!updated) return c.json({ error: "Este bot não tem endereço de e-mail" }, 404);
			return c.json(await tabPayload(botId, userId));
		} catch {
			return c.json({ error: "Não foi possível salvar" }, 503);
		}
	});

	app.delete("/v1/bots/:botId/email", async (c) => {
		try {
			const userId = userOf(c);
			const botId = c.req.param("botId");
			const removed = await deps.service.disableForBot({ userId, botId });
			if (!removed) return c.json({ error: "Este bot não tem endereço de e-mail" }, 404);
			return c.json(await tabPayload(botId, userId));
		} catch (error) {
			const f = failure(error);
			return c.json(f.body, f.status);
		}
	});

	app.get("/v1/bots/:botId/email/messages", async (c) => {
		try {
			const userId = userOf(c);
			const botId = c.req.param("botId");
			if (!(await deps.getMailbox(botId, userId))) return c.json({ error: "Este bot não tem endereço de e-mail" }, 404);
			const rows = await deps.listMessages(botId, userId, 30);
			return c.json({ messages: rows.map(toEmailMessageDto) });
		} catch {
			return c.json({ error: "Não foi possível carregar as mensagens" }, 503);
		}
	});

	return app;
}
