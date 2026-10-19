import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	EMAIL_DAILY_LIMIT_DEFAULT,
	emailSnippet,
	normalizeEmailAddress,
	type BotMailboxDto,
	type EmailDirection,
	type EmailMessageDto,
	type EmailMessageStatus,
	type EmailProviderId,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { ensureBotConversation, resolveBotModel } from "./bot-messages.js";
import { createAgentRun } from "./runs.js";
import { emitUserNeeded } from "./user-needed.js";

/**
 * Caixa de e-mail do bot (BotMailbox) e metadados das mensagens (EmailMessage).
 * Segredos só em `secretsEnc` (cifrados por quem chama); aqui nunca há texto em claro de chave.
 */

export type BotMailboxRecord = {
	id: string;
	botId: string;
	userId: string;
	provider: string;
	address: string;
	providerInboxId: string;
	secretsEnc: string | null;
	webhookSecretHash: string;
	allowedSenders: string[];
	dailySendLimit: number;
	enabled: boolean;
	createdAt: Date;
};

export type EmailMessageRecord = {
	id: string;
	mailboxId: string;
	userId: string;
	direction: string;
	providerMessageId: string;
	threadId: string;
	fromAddr: string;
	toAddrs: string[];
	subject: string;
	snippet: string;
	status: string;
	conversationId: string | null;
	runId: string | null;
	createdAt: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Token aleatório que vai na URL do webhook (só o hash fica no banco). */
export function newWebhookToken(): { token: string; hash: string } {
	const token = randomBytes(24).toString("base64url");
	return { token, hash: hashWebhookToken(token) };
}

export function hashWebhookToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function webhookTokenMatches(hash: string, token: string | undefined | null): boolean {
	if (!token) return false;
	const expected = Buffer.from(hash, "hex");
	const got = Buffer.from(hashWebhookToken(token), "hex");
	return expected.length === got.length && timingSafeEqual(expected, got);
}

export function toMailboxDto(row: BotMailboxRecord, sentToday: number): BotMailboxDto {
	return {
		id: row.id,
		botId: row.botId,
		provider: row.provider as EmailProviderId,
		address: row.address,
		allowedSenders: row.allowedSenders,
		dailySendLimit: row.dailySendLimit,
		sentToday,
		enabled: row.enabled,
		createdAt: row.createdAt.toISOString(),
	};
}

export function toEmailMessageDto(row: EmailMessageRecord): EmailMessageDto {
	return {
		id: row.id,
		direction: row.direction === "out" ? "out" : "in",
		threadId: row.threadId,
		from: row.fromAddr,
		to: row.toAddrs,
		subject: row.subject,
		snippet: row.snippet,
		status: row.status as EmailMessageStatus,
		conversationId: row.conversationId,
		createdAt: row.createdAt.toISOString(),
	};
}

/** Caixa do bot, só se o bot for do usuário. */
export async function getMailboxForBot(botId: string, userId: string): Promise<BotMailboxRecord | null> {
	if (!userId.trim() || userId === "default") return null;
	return (await prisma.botMailbox.findFirst({ where: { botId, userId, bot: { is: { ownerId: userId } } } })) as BotMailboxRecord | null;
}

/** Busca por id para o webhook de entrada (sem sessão): a autenticação é por assinatura + token. */
export async function getMailboxById(id: string): Promise<BotMailboxRecord | null> {
	return (await prisma.botMailbox.findUnique({ where: { id } })) as BotMailboxRecord | null;
}

export async function createMailbox(input: {
	/** Id escolhido antes (o webhook registrado no provedor já leva o id na URL). */
	id?: string;
	botId: string;
	userId: string;
	provider: EmailProviderId;
	address: string;
	providerInboxId: string;
	secretsEnc: string | null;
	webhookSecretHash: string;
	allowedSenders?: string[];
	dailySendLimit?: number;
}): Promise<BotMailboxRecord> {
	const bot = await prisma.bot.findFirst({ where: { id: input.botId, ownerId: input.userId }, select: { id: true } });
	if (!bot) throw new Error("Bot não encontrado");
	return (await prisma.botMailbox.create({
		data: {
			...(input.id ? { id: input.id } : {}),
			botId: input.botId,
			userId: input.userId,
			provider: input.provider,
			address: input.address,
			providerInboxId: input.providerInboxId,
			secretsEnc: input.secretsEnc,
			webhookSecretHash: input.webhookSecretHash,
			allowedSenders: input.allowedSenders ?? [],
			dailySendLimit: input.dailySendLimit ?? EMAIL_DAILY_LIMIT_DEFAULT,
		},
	})) as BotMailboxRecord;
}

export async function updateMailboxSettings(
	botId: string,
	userId: string,
	patch: { allowedSenders?: string[]; dailySendLimit?: number; enabled?: boolean; secretsEnc?: string | null },
): Promise<BotMailboxRecord | null> {
	const current = await getMailboxForBot(botId, userId);
	if (!current) return null;
	return (await prisma.botMailbox.update({
		where: { id: current.id },
		data: {
			...(patch.allowedSenders ? { allowedSenders: patch.allowedSenders } : {}),
			...(patch.dailySendLimit !== undefined ? { dailySendLimit: patch.dailySendLimit } : {}),
			...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
			...(patch.secretsEnc !== undefined ? { secretsEnc: patch.secretsEnc } : {}),
		},
	})) as BotMailboxRecord;
}

export async function deleteMailbox(botId: string, userId: string): Promise<boolean> {
	const current = await getMailboxForBot(botId, userId);
	if (!current) return false;
	await prisma.botMailbox.delete({ where: { id: current.id } });
	return true;
}

/** Enviados nas últimas 24 horas (a janela é móvel, não "hoje" do calendário). */
export async function countSentLast24h(mailboxId: string, now: Date = new Date()): Promise<number> {
	return prisma.emailMessage.count({
		where: { mailboxId, direction: "out", status: "sent", createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
	});
}

export type RecordEmailInput = {
	mailbox: Pick<BotMailboxRecord, "id" | "userId">;
	direction: EmailDirection;
	providerMessageId: string;
	threadId: string;
	from: string;
	to: string[];
	subject: string;
	body: string;
	status: EmailMessageStatus;
};

/** Grava os metadados. `created: false` quando o `providerMessageId` já existia (entrega repetida). */
export async function recordEmailMessage(input: RecordEmailInput): Promise<{ created: boolean; row: EmailMessageRecord }> {
	const existing = (await prisma.emailMessage.findUnique({
		where: { mailboxId_providerMessageId: { mailboxId: input.mailbox.id, providerMessageId: input.providerMessageId } },
	})) as EmailMessageRecord | null;
	if (existing) return { created: false, row: existing };
	try {
		const row = (await prisma.emailMessage.create({
			data: {
				mailboxId: input.mailbox.id,
				userId: input.mailbox.userId,
				direction: input.direction,
				providerMessageId: input.providerMessageId,
				threadId: input.threadId,
				fromAddr: input.from,
				toAddrs: input.to,
				subject: input.subject.slice(0, 300),
				snippet: emailSnippet(input.body),
				status: input.status,
			},
		})) as EmailMessageRecord;
		return { created: true, row };
	} catch (error) {
		// Corrida entre duas entregas do mesmo evento: o índice único decide.
		const again = (await prisma.emailMessage.findUnique({
			where: { mailboxId_providerMessageId: { mailboxId: input.mailbox.id, providerMessageId: input.providerMessageId } },
		})) as EmailMessageRecord | null;
		if (again) return { created: false, row: again };
		throw error;
	}
}

export async function linkEmailMessage(id: string, link: { conversationId?: string; runId?: string }): Promise<void> {
	await prisma.emailMessage.update({ where: { id }, data: { ...link } }).catch(() => undefined);
}

export async function listEmailMessages(botId: string, userId: string, limit = 30): Promise<EmailMessageRecord[]> {
	const mailbox = await getMailboxForBot(botId, userId);
	if (!mailbox) return [];
	return (await prisma.emailMessage.findMany({
		where: { mailboxId: mailbox.id, userId },
		orderBy: { createdAt: "desc" },
		take: Math.max(1, Math.min(100, Math.floor(limit))),
	})) as EmailMessageRecord[];
}

/** Mensagens de uma thread da caixa, mais antigas primeiro. */
export async function listThreadEmailMessages(mailboxId: string, threadId: string): Promise<EmailMessageRecord[]> {
	return (await prisma.emailMessage.findMany({ where: { mailboxId, threadId }, orderBy: { createdAt: "asc" }, take: 100 })) as EmailMessageRecord[];
}

/**
 * Quem responde uma thread: o remetente da última mensagem recebida nela (nunca um endereço
 * escolhido pelo modelo). `null` se a thread não tem mensagem recebida registrada.
 */
export async function threadReplyTarget(mailboxId: string, threadId: string): Promise<{ to: string; subject: string } | null> {
	const row = (await prisma.emailMessage.findFirst({
		where: { mailboxId, threadId, direction: "in", status: "received" },
		orderBy: { createdAt: "desc" },
	})) as EmailMessageRecord | null;
	const to = row ? normalizeEmailAddress(row.fromAddr) : null;
	return row && to ? { to, subject: row.subject } : null;
}

export type StartEmailRunDeps = {
	enqueueRun: (runId: string) => Promise<boolean>;
	/** Acorda o worker quando a fala entrou num run que já estava ativo. */
	onMerged?: (runId: string) => void | Promise<void>;
	envDefaultModel: string;
	createRun?: typeof createAgentRun;
	resolveModel?: (botId: string, userId: string, envDefault: string) => Promise<string>;
};

/**
 * E-mail permitido vira uma fala na conversa do bot (marcador "E-mail · assunto") e dispara o run
 * (`origin: "email"`). Run ativo na conversa: a mensagem entra nele como `join`. A conversa é a do
 * bot (uma por bot); a thread do e-mail vai no texto, e as respostas usam `email_reply` com ela.
 */
export async function startEmailRun(
	deps: StartEmailRunDeps,
	input: { mailbox: Pick<BotMailboxRecord, "botId" | "userId">; framedText: string; subject: string },
): Promise<{ runId: string; conversationId: string; merged: boolean } | null> {
	const { botId, userId } = input.mailbox;
	const bot = await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { id: true, conversationId: true } });
	if (!bot) return null;
	const conversationId = await ensureBotConversation(botId, userId, bot.conversationId);
	const model = await (deps.resolveModel ?? resolveBotModel)(botId, userId, deps.envDefaultModel);
	let merged = false;
	const run = await (deps.createRun ?? createAgentRun)({
		userId,
		onMergedIntoActiveRun: async (runId) => {
			merged = true;
			await deps.onMerged?.(runId);
		},
		model,
		request: {
			botId,
			conversationId,
			origin: "email",
			objective: input.framedText,
			messages: [{ role: "user", content: input.framedText }],
			// A fala é gravada abaixo, com o marcador de e-mail.
			silent: true,
		},
	});
	await prisma.conversationMessage.create({
		data: {
			conversationId,
			role: "user",
			content: input.framedText,
			sourceKind: "email",
			sourceLabel: input.subject.replace(/\s+/g, " ").trim().slice(0, 80) || "(sem assunto)",
			sourceAt: new Date(),
		},
	});
	if (!merged) await deps.enqueueRun(run.id);
	return { runId: run.id, conversationId, merged };
}

/** Avisa o dono de um e-mail de remetente fora da lista (push, quando houver). Nunca lança. */
export async function notifyBlockedSender(mailbox: Pick<BotMailboxRecord, "botId" | "userId">, from: string, messageId: string): Promise<void> {
	try {
		const bot = await prisma.bot.findFirst({ where: { id: mailbox.botId, ownerId: mailbox.userId }, select: { conversationId: true } });
		if (!bot?.conversationId) return;
		emitUserNeeded({ conversationId: bot.conversationId, cardId: messageId, detail: `E-mail bloqueado de ${from}` });
	} catch {
		// aviso é melhor esforço
	}
}

/** Desfaz o registro de um e-mail cuja entrega ao bot falhou (a reentrega do provedor pode tentar de novo). */
export async function forgetEmailMessage(id: string): Promise<void> {
	await prisma.emailMessage.deleteMany({ where: { id } });
}
