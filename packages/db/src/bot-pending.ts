import {
	BOT_LINK_ROLE,
	BOT_NEED_CARD_ROLES,
	needFromCardRow,
	parseBotAutoDecisionCard,
	readDecideForOtherBots,
	serializeBotLinkCard,
	type BotAutoDecisionCard,
	type BotNeed,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { getSkillPendingIntent } from "./skill-pending.js";

/**
 * Conversa entre bots: itens pendentes do bot de destino vistos pelo orquestrador
 * ("Decidir pelos outros bots"). Só leitura/escrita de linhas; a regra de decisão
 * mora em `@workspace/shared` e a aplicação da resposta na API (mesmo caminho do clique).
 */

const UNATTENDED_ORIGINS = new Set(["routine", "webhook", "subagent", "proactive"]);
/** Tipos que o orquestrador pode decidir (login/captcha/conector sempre vão ao usuário). */
const DECIDABLE_KINDS = new Set(["command", "write", "mcp", "questionnaire"]);
const AUTO_DECISION_SCAN = 80;

type ChainMessage = {
	id: string;
	userId: string;
	fromBotId: string;
	toBotId: string;
	fromConversationId: string | null;
	toConversationId: string | null;
	fromRunId: string | null;
	toRunId: string | null;
	rootId: string;
	title: string;
	content: string;
	createdAt: Date;
	deliveredAt: Date | null;
};

export function isDecidableNeed(need: BotNeed): boolean {
	return Boolean(need.item && DECIDABLE_KINDS.has(need.item.kind));
}

/** O bot tem "Decidir pelos outros bots" ligado? */
export async function botDecidesForOthers(botId: string, userId: string): Promise<boolean> {
	const bot = await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { policyJson: true } });
	return readDecideForOtherBots(bot?.policyJson);
}

/** A cadeia nasceu numa conversa com humano (não rotina/webhook/proativo/subagente)? */
export async function isChainAttended(message: { userId: string; rootId: string; id: string }): Promise<boolean> {
	const root = message.rootId === message.id ? message : await prisma.botMessage.findFirst({ where: { id: message.rootId, userId: message.userId }, select: { id: true, userId: true, rootId: true } });
	if (!root) return false;
	const full = await prisma.botMessage.findFirst({ where: { id: root.id, userId: message.userId }, select: { fromRunId: true } });
	if (!full?.fromRunId) return true;
	const run = await prisma.agentRun.findUnique({ where: { id: full.fromRunId }, select: { origin: true } });
	return !run || !UNATTENDED_ORIGINS.has(run.origin);
}

/** Cards do destino ainda esperando o usuário, nascidos depois da chegada do pedido. */
export async function listPendingNeeds(message: ChainMessage & { toConversationId: string }): Promise<BotNeed[]> {
	const arrival = await prisma.conversationMessage.findFirst({
		where: { conversationId: message.toConversationId, botMessageId: message.id, origin: "bot", role: "user" },
		select: { createdAt: true },
	});
	const cards = await prisma.conversationMessage.findMany({
		where: {
			conversationId: message.toConversationId,
			role: { in: [...BOT_NEED_CARD_ROLES] },
			createdAt: { gte: arrival?.createdAt ?? message.deliveredAt ?? message.createdAt },
		},
		orderBy: { createdAt: "asc" },
		take: 20,
	});
	const intent = await getSkillPendingIntent(message.userId, message.toConversationId).catch(() => null);
	const needs: BotNeed[] = [];
	for (const row of cards) {
		const payload = intent?.kind === "confirm" ? intent.payload : null;
		const need = needFromCardRow({
			rowId: row.id,
			conversationId: row.conversationId,
			role: row.role,
			content: row.content,
			targetRunId: message.toRunId,
			intent: payload ? { action: payload.action, confirmId: payload.confirmId, actionClass: payload.mcpCall?.actionClass } : null,
		});
		if (need) needs.push(need);
	}
	return needs;
}

/**
 * Item que o orquestrador `botId` pode responder: o card existe, está pendente e
 * pertence à conversa de um bot a quem ELE enviou pedido (mesmo dono).
 */
export async function findPendingForOrchestrator(input: {
	userId: string;
	orchestratorBotId: string;
	handle: string;
}): Promise<{ message: ChainMessage & { toConversationId: string }; need: BotNeed; botName: string } | null> {
	const row = await prisma.conversationMessage.findUnique({ where: { id: input.handle } });
	if (!row) return null;
	const message = await prisma.botMessage.findFirst({
		where: { userId: input.userId, fromBotId: input.orchestratorBotId, toConversationId: row.conversationId },
		orderBy: { createdAt: "desc" },
	});
	if (!message || !message.toConversationId) return null;
	const needs = await listPendingNeeds({ ...message, toConversationId: message.toConversationId });
	const need = needs.find((candidate) => candidate.cardId === input.handle);
	if (!need) return null;
	const bot = await prisma.bot.findFirst({ where: { id: message.toBotId, ownerId: input.userId }, select: { name: true } });
	return { message: { ...message, toConversationId: message.toConversationId }, need, botName: bot?.name ?? "Bot" };
}

/** Já existe decisão automática (fila ou aplicada) para este card na conversa do orquestrador? */
export async function hasAutoDecision(conversationId: string, cardId: string): Promise<boolean> {
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: BOT_LINK_ROLE, content: { contains: '"kind":"auto-decision"' } },
		orderBy: { createdAt: "desc" },
		take: AUTO_DECISION_SCAN,
		select: { content: true },
	});
	return rows.some((row: { content: string }) => {
		const card = parseBotAutoDecisionCard(row.content);
		return card !== null && card.need.cardId === cardId && card.status !== "failed";
	});
}

/**
 * Já houve nota de aceite do principal do grupo para este card, em QUALQUER estado (inclusive `failed`)?
 * Depois de uma falha não se cria outra: o card segue esperando o usuário, sem "Aceito por X" repetido.
 */
export async function hasGroupAutoDecision(conversationId: string, cardId: string): Promise<boolean> {
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: BOT_LINK_ROLE, content: { contains: '"kind":"auto-decision"' } },
		orderBy: { createdAt: "desc" },
		take: AUTO_DECISION_SCAN,
		select: { content: true },
	});
	return rows.some((row: { content: string }) => {
		const card = parseBotAutoDecisionCard(row.content);
		return card !== null && card.viaGroup === true && card.need.cardId === cardId;
	});
}

/** Grava a nota de decisão automática (uma por card). `false` = já existia. */
export async function queueAutoDecision(conversationId: string, card: BotAutoDecisionCard): Promise<boolean> {
	if (await (card.viaGroup ? hasGroupAutoDecision : hasAutoDecision)(conversationId, card.need.cardId)) return false;
	await prisma.conversationMessage.create({
		data: { conversationId, role: BOT_LINK_ROLE, content: serializeBotLinkCard(card) },
	});
	return true;
}

export type QueuedAutoDecision = { rowId: string; conversationId: string; userId: string | null; createdAt: Date; card: BotAutoDecisionCard };

/** Decisões automáticas esperando a API responder o card do destino. */
export async function listQueuedAutoDecisions(limit = 20): Promise<QueuedAutoDecision[]> {
	const rows = await prisma.conversationMessage.findMany({
		where: { role: BOT_LINK_ROLE, AND: [{ content: { contains: '"kind":"auto-decision"' } }, { content: { contains: '"status":"queued"' } }] },
		orderBy: { createdAt: "asc" },
		take: limit,
		include: { conversation: { select: { userId: true } } },
	});
	const out: QueuedAutoDecision[] = [];
	for (const row of rows) {
		const card = parseBotAutoDecisionCard(row.content);
		if (card && card.status === "queued") out.push({ rowId: row.id, conversationId: row.conversationId, userId: row.conversation?.userId ?? null, createdAt: row.createdAt, card });
	}
	return out;
}

/** `queued` -> `applied`/`failed`, uma vez (quem perdeu a corrida não repete a aplicação). */
export async function claimAutoDecision(rowId: string): Promise<BotAutoDecisionCard | null> {
	const row = await prisma.conversationMessage.findUnique({ where: { id: rowId } });
	if (!row) return null;
	const card = parseBotAutoDecisionCard(row.content);
	if (!card || card.status !== "queued") return null;
	const claimed = await prisma.conversationMessage.updateMany({
		where: { id: rowId, content: row.content },
		data: { content: serializeBotLinkCard({ ...card, status: "applied" }) },
	});
	return claimed.count === 1 ? card : null;
}

export async function failAutoDecision(rowId: string, reason?: string): Promise<void> {
	const row = await prisma.conversationMessage.findUnique({ where: { id: rowId } });
	if (!row) return;
	const card = parseBotAutoDecisionCard(row.content);
	if (!card || card.status === "failed") return;
	await prisma.conversationMessage.update({ where: { id: rowId }, data: { content: serializeBotLinkCard({ ...card, status: "failed", ...(reason ? { reason: reason.slice(0, 300) } : {}) }) } });
}

/** Decisões automáticas já tomadas num pedido (teto contra laço de aprovações). */
export async function countAutoDecisions(conversationId: string, botMessageId: string): Promise<number> {
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: BOT_LINK_ROLE, content: { contains: '"kind":"auto-decision"' } },
		orderBy: { createdAt: "desc" },
		take: AUTO_DECISION_SCAN,
		select: { content: true },
	});
	return rows.filter((row: { content: string }) => parseBotAutoDecisionCard(row.content)?.botMessageId === botMessageId).length;
}

/** O que o usuário pediu quando a cadeia começou (para o orquestrador e o Jev julgarem). */
export async function chainUserRequest(message: { userId: string; rootId: string; id: string }): Promise<string> {
	const root = await prisma.botMessage.findFirst({
		where: { id: message.rootId, userId: message.userId },
		select: { fromConversationId: true, createdAt: true },
	});
	if (!root?.fromConversationId) return "";
	const row = await prisma.conversationMessage.findFirst({
		where: { conversationId: root.fromConversationId, role: "user", origin: null, createdAt: { lte: root.createdAt } },
		orderBy: { createdAt: "desc" },
		select: { content: true },
	});
	return row?.content.slice(0, 1_500) ?? "";
}
