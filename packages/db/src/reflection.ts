import { Prisma } from "@prisma/client";
import {
	parseConversationCard,
	readReflectionSettings,
	type ReflectionBotInput,
	type ReflectionChange,
	type ReflectionEvent,
	type ReflectionInput,
	type ReflectionMemory,
	type ReflectionSettings,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { appendConversationCard } from "./conversations.js";
import { refreshMemoryEmbedding } from "./memory-entries.js";
import { memoryMetaOf, recordMemoryChange } from "./memory-changes.js";
import { listDislikedReplies } from "./message-reactions.js";

/**
 * Reflexão do orquestrador: fila/registro (`orchestrator_reflections`), leitura do que aconteceu
 * em TODOS os bots do usuário e mutações por id (sempre conferindo o dono). Escrever no perfil de
 * outro bot não existe aqui: as únicas escritas cruzadas são limpeza (unir/remover) dentro do
 * mesmo bot, e fatos novos só na memória do orquestrador.
 */

export const REFLECTION_SOURCE_KIND = "reflection";
/** Reflexão "running" há mais que isso é considerada morta (worker caiu). */
const STALE_RUNNING_MS = 20 * 60_000;
/** Janela de leitura quando nunca houve reflexão. */
const FIRST_WINDOW_MS = 7 * 24 * 60 * 60_000;
const RECENT_PER_BOT = 8;
const EVENT_SCAN_LIMIT = 120;
const RUN_SCAN_LIMIT = 60;

export type ReflectionRow = Prisma.OrchestratorReflectionGetPayload<Record<string, never>>;
export type ReflectionTrigger = "scheduled" | "manual";
export type ReflectionStatus = "queued" | "running" | "done" | "skipped" | "failed";

export type ReflectionView = {
	id: string;
	trigger: ReflectionTrigger;
	status: ReflectionStatus;
	summary: string | null;
	important: boolean;
	detail: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	changes: ReflectionChange[];
	stats: Record<string, unknown> | null;
};

export function toReflectionView(row: ReflectionRow): ReflectionView {
	return {
		id: row.id,
		trigger: row.trigger === "manual" ? "manual" : "scheduled",
		status: (["queued", "running", "done", "skipped", "failed"].includes(row.status) ? row.status : "failed") as ReflectionStatus,
		summary: row.summary,
		important: row.important,
		detail: row.detail,
		createdAt: row.createdAt.toISOString(),
		startedAt: row.startedAt?.toISOString() ?? null,
		finishedAt: row.finishedAt?.toISOString() ?? null,
		changes: Array.isArray(row.changesJson) ? (row.changesJson as unknown as ReflectionChange[]) : [],
		stats: row.statsJson && typeof row.statsJson === "object" && !Array.isArray(row.statsJson) ? (row.statsJson as Record<string, unknown>) : null,
	};
}

export async function getPrimaryBot(userId: string) {
	return prisma.bot.findFirst({
		where: { ownerId: userId, isPrimary: true },
		select: { id: true, name: true, conversationId: true, language: true },
	});
}

/** Usuários com a reflexão ligada (config da conta) e as respectivas configurações. */
export async function listReflectionUsers(): Promise<Array<{ userId: string; settings: ReflectionSettings; timezone: string | undefined }>> {
	const rows = await prisma.userSettings.findMany({
		where: { userId: { not: null }, configJson: { path: ["reflection", "enabled"], equals: true } },
		select: { userId: true, configJson: true },
	});
	return rows.flatMap((row) => {
		if (!row.userId) return [];
		const config = (row.configJson ?? {}) as { reflection?: { enabled?: unknown; time?: unknown }; general?: { timezone?: string } };
		return [{ userId: row.userId, settings: readReflectionSettings(config), timezone: config.general?.timezone }];
	});
}

/** Última tentativa (qualquer resultado) e último corte concluído, para saber se é hora e o que ler. */
export async function getReflectionClock(userId: string): Promise<{ lastAttemptAt: Date | null; lastDoneAt: Date | null }> {
	const [attempt, done] = await Promise.all([
		prisma.orchestratorReflection.findFirst({
			where: { userId, status: { not: "queued" }, startedAt: { not: null } },
			orderBy: { startedAt: "desc" },
			select: { startedAt: true },
		}),
		prisma.orchestratorReflection.findFirst({
			where: { userId, status: "done", startedAt: { not: null } },
			orderBy: { startedAt: "desc" },
			select: { startedAt: true },
		}),
	]);
	return { lastAttemptAt: attempt?.startedAt ?? null, lastDoneAt: done?.startedAt ?? null };
}

/**
 * Reserva a reflexão agendada do dia (uma por horário, mesmo com vários workers). `null` = outro
 * worker já pegou, já houve tentativa depois do horário ou há uma rodando.
 */
export async function claimScheduledReflection(input: {
	userId: string;
	botId: string;
	now: Date;
	slotStart: Date;
}): Promise<ReflectionRow | null> {
	return prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reflection:${input.userId}`}))`;
		const busy = await tx.orchestratorReflection.findFirst({
			where: {
				userId: input.userId,
				OR: [
					{ status: "running", startedAt: { gte: new Date(input.now.getTime() - STALE_RUNNING_MS) } },
					{ status: { notIn: ["queued", "running"] }, startedAt: { gte: input.slotStart } },
				],
			},
			select: { id: true },
		});
		if (busy) return null;
		const done = await tx.orchestratorReflection.findFirst({
			where: { userId: input.userId, status: "done", startedAt: { not: null } },
			orderBy: { startedAt: "desc" },
			select: { startedAt: true },
		});
		return tx.orchestratorReflection.create({
			data: { userId: input.userId, botId: input.botId, trigger: "scheduled", status: "running", startedAt: input.now, sinceAt: done?.startedAt ?? null },
		});
	});
}

export type EnqueueManualResult = { ok: true; id: string } | { ok: false; reason: "no-primary" | "busy" };

/** "Refletir agora": entra na fila; o worker pega na próxima passada. Um pedido por vez. */
export async function enqueueManualReflection(userId: string, now: Date = new Date()): Promise<EnqueueManualResult> {
	const bot = await getPrimaryBot(userId);
	if (!bot) return { ok: false, reason: "no-primary" };
	return prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reflection:${userId}`}))`;
		const busy = await tx.orchestratorReflection.findFirst({
			where: {
				userId,
				OR: [{ status: "queued" }, { status: "running", startedAt: { gte: new Date(now.getTime() - STALE_RUNNING_MS) } }],
			},
			select: { id: true },
		});
		if (busy) return { ok: false as const, reason: "busy" as const };
		const row = await tx.orchestratorReflection.create({ data: { userId, botId: bot.id, trigger: "manual", status: "queued" } });
		return { ok: true as const, id: row.id };
	});
}

/** Pega o pedido manual mais antigo (um worker por linha) e o põe em execução. */
export async function claimQueuedReflection(now: Date): Promise<ReflectionRow | null> {
	const rows = await prisma.$queryRaw<Array<{ id: string; userId: string }>>`
		UPDATE "orchestrator_reflections" SET "status" = 'running', "startedAt" = ${now}
		WHERE "id" = (
			SELECT "id" FROM "orchestrator_reflections" WHERE "status" = 'queued'
			ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED
		)
		RETURNING "id", "userId"`;
	const claimed = rows[0];
	if (!claimed) return null;
	const id = claimed.id;
	const done = await prisma.orchestratorReflection.findFirst({
		where: { userId: claimed.userId, status: "done", startedAt: { not: null } },
		orderBy: { startedAt: "desc" },
		select: { startedAt: true },
	});
	return prisma.orchestratorReflection.update({ where: { id }, data: { sinceAt: done?.startedAt ?? null } });
}

export async function finishReflection(
	id: string,
	patch: { status: "done" | "skipped" | "failed"; summary?: string; important?: boolean; changes?: ReflectionChange[]; stats?: Record<string, unknown>; detail?: string; now?: Date },
): Promise<void> {
	await prisma.orchestratorReflection.update({
		where: { id },
		data: {
			status: patch.status,
			summary: patch.summary?.slice(0, 4000) ?? null,
			important: patch.important ?? false,
			changesJson: (patch.changes ?? []) as unknown as Prisma.InputJsonValue,
			statsJson: (patch.stats ?? {}) as Prisma.InputJsonValue,
			detail: patch.detail?.slice(0, 300) ?? null,
			finishedAt: patch.now ?? new Date(),
		},
	});
}

/** Reflexões "running" abandonadas (worker caiu) viram falha. */
export async function failStaleReflections(now: Date): Promise<number> {
	const result = await prisma.orchestratorReflection.updateMany({
		where: { status: "running", startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
		data: { status: "failed", detail: "interrompida (servidor reiniciou)", finishedAt: now },
	});
	return result.count;
}

export async function listReflections(userId: string, limit = 10): Promise<ReflectionView[]> {
	const rows = await prisma.orchestratorReflection.findMany({
		where: { userId },
		orderBy: { createdAt: "desc" },
		take: Math.max(1, Math.min(50, limit)),
	});
	return rows.map(toReflectionView);
}

// ---------------------------------------------------------------------------
// Leitura do que aconteceu
// ---------------------------------------------------------------------------

const clip = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

type BotRow = { id: string; name: string; snippet: string; description: string | null; isPrimary: boolean; conversationId: string | null };

async function listOwnBots(userId: string): Promise<BotRow[]> {
	return prisma.bot.findMany({
		where: { ownerId: userId, memberIds: { isEmpty: true } },
		orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
		select: { id: true, name: true, snippet: true, description: true, isPrimary: true, conversationId: true },
	});
}

/** Há atividade nova (mensagens que não são da própria reflexão ou runs com erro) desde `since`? */
export async function hasActivitySince(userId: string, since: Date | null, now: Date = new Date()): Promise<boolean> {
	const from = since ?? new Date(now.getTime() - FIRST_WINDOW_MS);
	const bots = await listOwnBots(userId);
	const conversationIds = bots.flatMap((bot) => (bot.conversationId ? [bot.conversationId] : []));
	if (conversationIds.length > 0) {
		const message = await prisma.conversationMessage.findFirst({
			where: {
				conversationId: { in: conversationIds },
				createdAt: { gt: from },
				role: { in: ["user", "assistant"] },
				OR: [{ sourceKind: null }, { sourceKind: { not: REFLECTION_SOURCE_KIND } }],
			},
			select: { id: true },
		});
		if (message) return true;
	}
	const failed = await prisma.agentRun.findFirst({
		where: { userId, status: "failed", origin: { not: "subagent" }, createdAt: { gt: from } },
		select: { id: true },
	});
	return Boolean(failed);
}

function toMemory(row: { id: string; target: string; content: string; category: string | null; importance: number | null; validUntil: Date | null; source: string | null; createdAt: Date; updatedAt: Date }): ReflectionMemory {
	return {
		id: row.id,
		target: row.target === "user" ? "user" : "memory",
		content: row.content,
		category: row.category,
		importance: row.importance,
		validUntil: row.validUntil,
		source: row.source,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Memórias (todos os bots + perfil `user`), resumos, mensagens e eventos desde `since`, em um objeto só. */
export async function loadReflectionInput(input: { userId: string; since: Date | null; now: Date; timeZone: string }): Promise<ReflectionInput & { primaryBotId: string | null }> {
	const { userId, now } = input;
	const from = input.since ?? new Date(now.getTime() - FIRST_WINDOW_MS);
	const bots = await listOwnBots(userId);
	const botIds = bots.map((bot) => bot.id);
	const conversationIds = bots.flatMap((bot) => (bot.conversationId ? [bot.conversationId] : []));
	const botByConversation = new Map(bots.flatMap((bot) => (bot.conversationId ? [[bot.conversationId, bot] as const] : [])));

	const dislikes = await listDislikedReplies({ userId, conversationIds, since: from }).catch(() => []);
	const [memoryRows, summaries, sourced, failedRuns] = await Promise.all([
		prisma.memoryEntry.findMany({
			where: { userId, OR: [{ target: "user" }, { target: "memory", botId: { in: botIds } }] },
			orderBy: { updatedAt: "desc" },
			select: { id: true, target: true, botId: true, content: true, category: true, importance: true, validUntil: true, source: true, createdAt: true, updatedAt: true },
		}),
		Promise.all(
			conversationIds.map(async (conversationId) => {
				const row = await prisma.conversationSummary.findFirst({ where: { conversationId }, orderBy: { version: "desc" }, select: { content: true } });
				return [conversationId, row?.content ?? null] as const;
			}),
		),
		conversationIds.length
			? prisma.conversationMessage.findMany({
					where: { conversationId: { in: conversationIds }, createdAt: { gt: from }, sourceKind: { in: ["webhook", "github", "routine", "reminder"] } },
					orderBy: { createdAt: "desc" },
					take: EVENT_SCAN_LIMIT,
					select: { conversationId: true, content: true, sourceKind: true, sourceLabel: true, createdAt: true },
				})
			: Promise.resolve([]),
		prisma.agentRun.findMany({
			where: { userId, status: "failed", origin: { not: "subagent" }, botId: { in: botIds }, createdAt: { gt: from } },
			orderBy: { createdAt: "desc" },
			take: RUN_SCAN_LIMIT,
			select: { botId: true, origin: true, objective: true, error: true, createdAt: true },
		}),
	]);
	const summaryByConversation = new Map(summaries);

	const botInputs: ReflectionBotInput[] = await Promise.all(
		bots.map(async (bot) => {
			const conversationId = bot.conversationId;
			const [count, recent] = conversationId
				? await Promise.all([
						prisma.conversationMessage.count({
							where: { conversationId, createdAt: { gt: from }, role: { in: ["user", "assistant"] }, OR: [{ sourceKind: null }, { sourceKind: { not: REFLECTION_SOURCE_KIND } }] },
						}),
						prisma.conversationMessage.findMany({
							where: { conversationId, createdAt: { gt: from }, role: { in: ["user", "assistant"] }, OR: [{ sourceKind: null }, { sourceKind: { not: REFLECTION_SOURCE_KIND } }] },
							orderBy: { createdAt: "desc" },
							take: RECENT_PER_BOT,
							select: { role: true, content: true, createdAt: true },
						}),
					])
				: [0, []];
			const events: ReflectionEvent[] = [];
			for (const message of sourced) {
				if (botByConversation.get(message.conversationId)?.id !== bot.id || !message.sourceKind) continue;
				events.push({
					botId: bot.id,
					botName: bot.name,
					kind: message.sourceKind as ReflectionEvent["kind"],
					label: message.sourceLabel ?? message.sourceKind,
					detail: clip(message.content, 200),
					ok: message.sourceKind === "routine" || message.sourceKind === "reminder" ? true : undefined,
					at: message.createdAt,
				});
			}
			for (const run of failedRuns) {
				if (run.botId !== bot.id) continue;
				const kind = run.origin === "routine" ? "routine" : run.origin === "proactive" ? "reminder" : "run-failed";
				events.push({ botId: bot.id, botName: bot.name, kind, label: clip(run.objective, 80), detail: clip(run.error ?? "falhou", 160), ok: false, at: run.createdAt });
			}
			return {
				id: bot.id,
				name: bot.name,
				snippet: bot.snippet,
				description: bot.description,
				isOrchestrator: bot.isPrimary,
				memories: memoryRows.filter((row) => row.target === "memory" && row.botId === bot.id).map(toMemory),
				summary: conversationId ? (summaryByConversation.get(conversationId) ?? null) : null,
				recent: recent.reverse().map((message) => ({ role: message.role === "user" ? ("user" as const) : ("assistant" as const), text: message.content, at: message.createdAt })),
				newMessages: count,
				events,
				dislikedReplies: dislikes.filter((item) => item.conversationId === conversationId).map(({ text, at }) => ({ text, at })),
			};
		}),
	);
	return {
		now,
		timeZone: input.timeZone,
		since: input.since,
		userMemories: memoryRows.filter((row) => row.target === "user").map(toMemory),
		bots: botInputs,
		primaryBotId: bots.find((bot) => bot.isPrimary)?.id ?? null,
	};
}

// ---------------------------------------------------------------------------
// Mutações por id (sempre conferindo o dono)
// ---------------------------------------------------------------------------

type OwnedMemory = { id: string; botId: string | null; target: string; content: string; category: string | null; importance: number | null };

/** A entrada é do usuário e está em um store que a reflexão pode tocar (`user` ou `memory` de um bot dele)? */
export async function getOwnedMemory(userId: string, id: string): Promise<OwnedMemory | null> {
	const row = await prisma.memoryEntry.findFirst({
		where: { id, userId },
		select: { id: true, botId: true, target: true, content: true, category: true, importance: true },
	});
	if (!row) return null;
	if (row.target === "user") return row;
	if (!row.botId) return null;
	const bot = await prisma.bot.findFirst({ where: { id: row.botId, ownerId: userId }, select: { id: true } });
	return bot ? row : null;
}

export async function updateOwnedMemory(
	userId: string,
	id: string,
	patch: { content: string; category?: string; importance?: number; validUntil?: Date | null; source?: string },
): Promise<boolean> {
	const owned = await getOwnedMemory(userId, id);
	if (!owned) return false;
	await prisma.$transaction(async (tx) => {
		const before = await tx.memoryEntry.findFirst({ where: { id, userId } });
		await tx.memoryEntry.update({
			where: { id },
			data: {
				content: patch.content,
				...(patch.category ? { category: patch.category } : {}),
				...(patch.importance !== undefined ? { importance: patch.importance } : {}),
				...(patch.validUntil !== undefined ? { validUntil: patch.validUntil } : {}),
				...(patch.source ? { source: patch.source } : {}),
			},
		});
		// Histórico (aba Memória): a reflexão diária muda a memória sozinha, então o usuário precisa poder ver e desfazer.
		if (before && before.content !== patch.content) {
			await recordMemoryChange(tx, {
				userId,
				botId: before.botId,
				entryId: id,
				target: before.target === "user" ? "user" : "memory",
				action: "replace",
				before: before.content,
				after: patch.content,
				beforeMeta: memoryMetaOf(before),
				source: "reflection",
			});
		}
	});
	await refreshMemoryEmbedding(id, patch.content);
	return true;
}

export async function deleteOwnedMemory(userId: string, id: string): Promise<boolean> {
	const owned = await getOwnedMemory(userId, id);
	if (!owned) return false;
	await prisma.$transaction(async (tx) => {
		const before = await tx.memoryEntry.findFirst({ where: { id, userId } });
		await tx.memoryEntry.delete({ where: { id } });
		if (before) {
			await recordMemoryChange(tx, {
				userId,
				botId: before.botId,
				entryId: id,
				target: before.target === "user" ? "user" : "memory",
				action: "remove",
				before: before.content,
				beforeMeta: memoryMetaOf(before),
				source: "reflection",
			});
		}
	});
	return true;
}

// ---------------------------------------------------------------------------
// Conversa do orquestrador
// ---------------------------------------------------------------------------

/** Conversa do bot principal (cria e vincula uma se ainda não tiver). */
export async function ensureBotConversation(userId: string, botId: string): Promise<string | null> {
	const bot = await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { conversationId: true } });
	if (!bot) return null;
	if (bot.conversationId) return bot.conversationId;
	const conversation = await prisma.conversation.create({ data: { userId } });
	await prisma.bot.updateMany({ where: { id: botId, ownerId: userId, conversationId: null }, data: { conversationId: conversation.id } });
	const after = await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { conversationId: true } });
	return after?.conversationId ?? null;
}

/** Mensagem curta da reflexão na conversa do orquestrador: resposta do bot (nunca fala do usuário), marcada como "Reflexão". */
export async function appendReflectionMessage(conversationId: string, content: string, at: Date, label: string): Promise<void> {
	await prisma.conversationMessage.create({
		data: { conversationId, role: "assistant", content, sourceKind: REFLECTION_SOURCE_KIND, sourceLabel: label, sourceAt: at },
	});
	await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }).catch(() => undefined);
}

/** Cartão "Atualizar perfil?" (o mesmo de `propose_profile_update`) na conversa do orquestrador; o clique chama /v1/cards/bot-profile/resolve. */
export async function appendProfileSuggestionCard(input: {
	userId: string;
	conversationId: string;
	proposalId: string;
	botId: string;
	after: { name?: string; snippet?: string; description?: string | null };
}): Promise<{ ok: true; fields: string[] } | { ok: false; reason: string }> {
	const bot = await prisma.bot.findFirst({
		where: { id: input.botId, ownerId: input.userId },
		select: { name: true, snippet: true, description: true, openRouterModel: true },
	});
	if (!bot) return { ok: false, reason: "bot não encontrado" };
	const fields: string[] = [];
	const after: { name?: string; snippet?: string; description?: string | null } = {};
	if (input.after.name !== undefined && input.after.name.trim() && input.after.name.trim() !== bot.name.trim()) {
		after.name = input.after.name.trim();
		fields.push("name");
	}
	if (input.after.snippet !== undefined && input.after.snippet.trim() !== bot.snippet.trim()) {
		after.snippet = input.after.snippet.trim();
		fields.push("snippet");
	}
	if (input.after.description !== undefined && (input.after.description ?? "").trim() !== (bot.description ?? "").trim()) {
		after.description = input.after.description === null ? null : input.after.description.trim();
		fields.push("description");
	}
	if (fields.length === 0) return { ok: false, reason: "sem mudanças em relação ao perfil atual" };
	const card = parseConversationCard(
		JSON.stringify({
			v: 1,
			kind: "bot-profile",
			proposalId: input.proposalId,
			botId: input.botId,
			before: { name: bot.name, snippet: bot.snippet, description: bot.description, openRouterModel: bot.openRouterModel },
			after,
			fields,
			status: "pending",
		}),
	);
	if (!card || card.kind !== "bot-profile") return { ok: false, reason: "proposta inválida" };
	await appendConversationCard(input.conversationId, card);
	return { ok: true, fields };
}


/** Estado de um run (para esperar a verificação): status e texto final. */
export async function getRunOutcome(runId: string): Promise<{ status: string; resultText: string | null; error: string | null } | null> {
	return prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true, resultText: true, error: true } });
}

/** Pede o cancelamento de um run (a verificação passou do prazo). */
export async function requestRunCancel(runId: string): Promise<void> {
	await prisma.agentRun.updateMany({ where: { id: runId, status: { in: ["queued", "running", "waiting_user", "waiting_external"] } }, data: { cancelRequested: true } });
}
