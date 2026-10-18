import { Prisma } from "@prisma/client";
import { BOT_LINK_ROLE, isBotLanguage, isMessageSourceKind, type Bot, type BotLanguage, type CreateBotInput, type UpdateBotInput } from "@workspace/shared";
import { prisma } from "./client.js";
import { unreadResultsByConversation } from "./deliveries.js";
import { getUnreadStates } from "./read-state.js";
import { listWorkingTargets } from "./runs.js";
import { ownerIds } from "./mcp-connections.js";

type BotRow = Prisma.BotGetPayload<Record<string, never>>;

/**
 * Filtro de posse do bot: só o dono explícito. Legado sem dono (`ownerId` null)
 * não é de ninguém até o claim-default migrar para o dono real; sessão sem
 * usuário válido (`"default"`/vazio) não casa com nada (`in: []`).
 */
function botOwnedBy(id: string, userId?: string): Prisma.BotWhereInput {
	return { id, ownerId: { in: ownerIds(userId) } };
}

function toBot(row: BotRow, lastMessage: Bot["lastMessage"] = null): Bot {
	return {
		id: row.id,
		name: row.name,
		snippet: row.snippet,
		color: row.color,
		shape: row.shape,
		description: row.description,
		openRouterModel: row.openRouterModel,
		language: isBotLanguage(row.language) ? row.language : "pt-BR",
		pinned: row.pinned,
		pinOrder: row.pinOrder,
		notify: row.notify,
		sectionId: row.sectionId,
		memberIds: row.memberIds,
		conversationId: row.conversationId,
		lastMessage,
		policyJson: (row.policyJson as unknown) ?? null,
		isPrimary: row.isPrimary,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

async function lastConversationMessage(
	conversationId: string | null,
): Promise<Bot["lastMessage"]> {
	if (!conversationId) return null;
	const message = await prisma.conversationMessage.findFirst({
		// O marcador "Enviou mensagem para X" é card interno, não texto de prévia.
		where: { conversationId, role: { not: BOT_LINK_ROLE } },
		orderBy: { createdAt: "desc" },
		select: { role: true, content: true, createdAt: true, sourceKind: true, sourceLabel: true },
	});
	if (!message) return null;
	return {
		role: message.role,
		content: message.content,
		createdAt: message.createdAt.toISOString(),
		...(isMessageSourceKind(message.sourceKind) && message.sourceLabel
			? { source: { kind: message.sourceKind, label: message.sourceLabel } }
			: {}),
	};
}

/** Tamanho máximo da prévia da última mensagem na lista (o resto só vem ao abrir a conversa). */
export const BOT_PREVIEW_MAX_CHARS = 200;

type PreviewRow = {
	conversationId: string;
	role: string;
	content: string;
	createdAt: Date;
	sourceKind: string | null;
	sourceLabel: string | null;
};

/**
 * Última mensagem de VÁRIAS conversas numa só consulta (antes: uma por bot). LATERAL com
 * LIMIT 1 usa o índice (conversationId, createdAt) por conversa, sem varrer o histórico, e o
 * `LEFT(content, 200)` evita trazer mensagens inteiras só para a prévia.
 */
export async function lastConversationMessages(
	conversationIds: string[],
): Promise<Map<string, NonNullable<Bot["lastMessage"]>>> {
	const result = new Map<string, NonNullable<Bot["lastMessage"]>>();
	const ids = [...new Set(conversationIds.filter(Boolean))];
	if (ids.length === 0) return result;
	const rows = await prisma.$queryRaw<PreviewRow[]>`
		SELECT m."conversationId", m."role", m."content", m."createdAt", m."sourceKind", m."sourceLabel"
		FROM unnest(${ids}::text[]) AS c("id")
		CROSS JOIN LATERAL (
			SELECT cm."conversationId", cm."role", LEFT(cm."content", ${BOT_PREVIEW_MAX_CHARS}::int) AS "content",
				cm."createdAt", cm."sourceKind", cm."sourceLabel"
			FROM "conversation_messages" cm
			WHERE cm."conversationId" = c."id" AND cm."role" <> ${BOT_LINK_ROLE}
			ORDER BY cm."createdAt" DESC, cm."id" DESC
			LIMIT 1
		) m
	`;
	for (const message of rows) {
		result.set(message.conversationId, {
			role: message.role as NonNullable<Bot["lastMessage"]>["role"],
			content: message.content,
			createdAt: message.createdAt.toISOString(),
			...(isMessageSourceKind(message.sourceKind) && message.sourceLabel
				? { source: { kind: message.sourceKind, label: message.sourceLabel } }
				: {}),
		});
	}
	return result;
}

/** Nome do bot (para títulos de fallback). Retorna null se não existir. */
export async function getBotName(
	botId: string | null | undefined,
	userId: string | undefined,
): Promise<string | null> {
	if (!botId) return null;
	const row = await prisma.bot.findFirst({
		where: botOwnedBy(botId, userId),
		select: { name: true },
	});
	return row?.name ?? null;
}

/** Identidade do bot (nome + papel) para injeção no prompt do LLM. */
export async function getBotIdentity(
	botId: string | null | undefined,
	userId: string | undefined,
): Promise<{ name: string; description: string | null } | null> {
	if (!botId) return null;
	const row = await prisma.bot.findFirst({
		where: botOwnedBy(botId, userId),
		select: { name: true, description: true },
	});
	if (!row) return null;
	return { name: row.name, description: row.description };
}

/** Perfil editável do bot (para diff de proposta de atualização). */
export async function getBotProfile(
	botId: string | null | undefined,
	userId: string | undefined,
): Promise<{
	name: string;
	snippet: string;
	description: string | null;
	openRouterModel: string | null;
	language: BotLanguage;
} | null> {
	if (!botId) return null;
	const row = await prisma.bot.findFirst({
		where: botOwnedBy(botId, userId),
		select: { name: true, snippet: true, description: true, openRouterModel: true, language: true },
	});
	if (!row) return null;
	return {
		name: row.name,
		snippet: row.snippet,
		description: row.description,
		openRouterModel: row.openRouterModel,
		language: isBotLanguage(row.language) ? row.language : "pt-BR",
	};
}

/** Política de orçamento bruta do bot (validada em resolveBudget). */
export async function getBotPolicy(
	botId: string | null | undefined,
	userId: string | undefined,
): Promise<unknown> {
	if (!botId) return null;
	const row = await prisma.bot.findFirst({
		where: botOwnedBy(botId, userId),
		select: { policyJson: true },
	});
	return (row?.policyJson as unknown) ?? null;
}

export async function listBots(ownerId: string | undefined): Promise<Bot[]> {
	// Só os bots do próprio dono. O legado sem dono vira do dono real no
	// claim-default; até lá não aparece para ninguém.
	const owners = ownerIds(ownerId);
	if (owners.length === 0) return [];
	const rows = await prisma.bot.findMany({
		where: { ownerId: { in: owners } },
		orderBy: { createdAt: "asc" },
	});
	const conversationIds = rows.flatMap((row) => (row.conversationId ? [row.conversationId] : []));
	// Consultas independentes em paralelo (antes: em fila, mais uma por bot para a prévia).
	const [unread, readStates, working, previews] = await Promise.all([
		// Resultados de runs em background que o dono ainda não viu (badge "novo").
		unreadResultsByConversation(owners[0]!),
		// Estado de leitura no servidor (igual em todos os dispositivos); falha não derruba a lista.
		getUnreadStates(owners[0]!, conversationIds).catch(() => new Map()),
		// Run em andamento (inclui rotina, evento e delegação): o avatar do bot e do grupo da conversa acende.
		listWorkingTargets(owners[0]!).catch(() => ({ botIds: new Set<string>(), conversationIds: new Set<string>() })),
		lastConversationMessages(conversationIds),
	]);
	return Promise.all(
		rows.map(async (row) => {
			const state = row.conversationId ? readStates.get(row.conversationId) : undefined;
			return {
				...toBot(row, (row.conversationId ? previews.get(row.conversationId) : undefined) ?? null),
				unreadResults: row.conversationId ? (unread.get(row.conversationId) ?? 0) : 0,
				unreadCount: state?.unreadCount ?? 0,
				firstUnreadMessageId: state?.firstUnreadMessageId ?? null,
				manualUnread: state?.manualUnread ?? false,
				working: working.botIds.has(row.id) || (row.conversationId ? working.conversationIds.has(row.conversationId) : false),
			};
		}),
	);
}

export async function createBot(input: CreateBotInput, ownerId: string | undefined): Promise<Bot> {
	const owner = ownerIds(ownerId)[0];
	if (!owner) throw new Error("Bot owner required");
	// Cada bot (ou grupo) tem sua própria conversa para o histórico.
	const conversation = await prisma.conversation.create({
		data: { userId: owner },
	});

	const row = await prisma.bot.create({
		data: {
			name: input.name,
			snippet: input.snippet ?? "",
			color: input.color ?? "#f44336",
			shape: input.shape ?? "rond",
			description: input.description ?? null,
			openRouterModel: input.openRouterModel ?? null,
			language: input.language ?? "pt-BR",
			memberIds: input.memberIds ?? [],
			conversationId: conversation.id,
			ownerId: owner,
		},
	});

	return toBot(row);
}

export async function updateBot(
	id: string,
	patch: UpdateBotInput,
	ownerId: string | undefined,
): Promise<Bot> {
	const owner = ownerIds(ownerId)[0];
	if (!owner) throw new Error("Bot not found");
	const data: Prisma.BotUncheckedUpdateInput = {};
	if (patch.name !== undefined) data.name = patch.name;
	if (patch.snippet !== undefined) data.snippet = patch.snippet;
	if (patch.color !== undefined) data.color = patch.color;
	if (patch.shape !== undefined) data.shape = patch.shape;
	if (patch.description !== undefined) data.description = patch.description;
	if (patch.openRouterModel !== undefined) {
		data.openRouterModel = patch.openRouterModel;
	}
	if (patch.language !== undefined) data.language = patch.language;
	if (patch.pinned !== undefined) data.pinned = patch.pinned;
	if (patch.pinOrder !== undefined) data.pinOrder = patch.pinOrder;
	if (patch.notify !== undefined) data.notify = patch.notify;
	if (patch.sectionId !== undefined) data.sectionId = patch.sectionId;
	if (patch.memberIds !== undefined) data.memberIds = patch.memberIds;
	if (patch.isPrimary === false) data.isPrimary = false;
	if (patch.policyJson !== undefined) {
		data.policyJson =
			patch.policyJson === null
				? Prisma.DbNull
				: (patch.policyJson as Prisma.InputJsonValue);
	}

	try {
		// Seção também é recurso do dono: não dá para pendurar o bot na de outro.
		if (patch.sectionId) {
			const section = await prisma.section.findFirst({
				where: { id: patch.sectionId, ownerId: owner },
				select: { id: true },
			});
			if (!section) throw new Error("Section not found");
		}
		// Marcar principal desmarca o anterior na mesma transação (índice parcial: 1 por dono).
		const row =
			patch.isPrimary === true
				? await prisma.$transaction(async (tx) => {
						await tx.bot.updateMany({ where: { ownerId: owner, isPrimary: true, id: { not: id } }, data: { isPrimary: false } });
						return tx.bot.update({ where: { id, ownerId: owner }, data: { ...data, isPrimary: true } });
					})
				: await prisma.bot.update({ where: { id, ownerId: owner }, data });
		return toBot(row, await lastConversationMessage(row.conversationId));
	} catch (error) {
		if (error instanceof Error && error.message === "Bot not found") throw error;
		if ((error as { code?: string }).code === "P2025") {
			throw new Error("Bot not found");
		}
		throw error;
	}
}

export async function deleteBot(id: string, ownerId: string | undefined): Promise<void> {
	const bot = await prisma.bot.findFirst({
		where: botOwnedBy(id, ownerId),
		select: { conversationId: true, ownerId: true, memberIds: true },
	});
	if (!bot?.ownerId) {
		throw new Error("Bot not found");
	}

	await prisma.bot.delete({ where: { id, ownerId: bot.ownerId } });

	// Grupo excluído: limpa a fila de respostas. Bot excluído: sai dos grupos dele.
	if (bot.memberIds.length > 0) {
		await prisma.groupReply.deleteMany({ where: { groupId: id } }).catch(() => undefined);
		await prisma.groupTurn.deleteMany({ where: { groupId: id } }).catch(() => undefined);
	} else {
		const groups = await prisma.bot.findMany({
			where: { ownerId: bot.ownerId, memberIds: { has: id } },
			select: { id: true, memberIds: true },
		});
		for (const group of groups) {
			await prisma.bot
				.update({ where: { id: group.id }, data: { memberIds: group.memberIds.filter((memberId) => memberId !== id) } })
				.catch(() => undefined);
			await prisma.groupReply
				.updateMany({ where: { groupId: group.id, botId: id, status: "pending" }, data: { status: "skipped", finishedAt: new Date() } })
				.catch(() => undefined);
		}
	}

	if (bot.conversationId) {
		await prisma.conversation
			.delete({ where: { id: bot.conversationId } })
			.catch(() => undefined);
	}
}

/**
 * Modelo configurado no bot, só se o bot for do usuário.
 * Usado para runs iniciados pelo servidor (questionário, confirms) herdarem
 * o modelo do bot em vez do padrão do ambiente.
 */
export async function getBotModelForUser(
	botId: string | null | undefined,
	userId: string,
): Promise<string | null> {
	if (!botId) return null;
	const row = await prisma.bot.findFirst({
		where: botOwnedBy(botId, userId),
		select: { openRouterModel: true },
	});
	return row?.openRouterModel?.trim() || null;
}
