import { Prisma } from "@prisma/client";
import {
	buildFollowupPrompt,
	buildReflectionPrompt,
	checkProactiveGate,
	findDuplicateFollowup,
	isReflectionDue,
	localDayWindow,
	advanceFollowupStages,
	nextAllowedTime,
	nextPendingStageIndex,
	normalizeNewStages,
	parseFollowupStages,
	planFollowupReschedule,
	pickEffectiveModel,
	readProactiveSettings,
	setFollowupStageAt,
	type FollowupStage,
	type ProactiveGate,
	type ProactiveSettings,
	type ReflectionContext,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { getBotModelForUser } from "./bots.js";
import { getMemorySnapshot } from "./memory-entries.js";
import { listConnectedMcpConnections } from "./mcp-connections.js";
import { getAccountConfig } from "./settings.js";
import { buildQueuedRunData, createAgentRun, listActiveRunsForConversation } from "./runs.js";
import { getLatestSummary } from "./summaries.js";

/** Teto de lembretes pendentes por bot (evita laço de agendamento). */
export const FOLLOWUP_MAX_PENDING = 30;
export const FOLLOWUP_NOTE_MAX_CHARS = 1000;
/** Tentativas de criar o run do lembrete antes de desistir. */
export const FOLLOWUP_MAX_ATTEMPTS = 5;
/** Quanto uma varredura reserva o lembrete enquanto cria o run. */
const FOLLOWUP_CLAIM_MS = 2 * 60_000;
const FOLLOWUP_BUSY_RETRY_MS = 2 * 60_000;
const FOLLOWUP_ERROR_RETRY_MS = 5 * 60_000;
const SWEEP_BATCH = 20;

export type FollowupKind = "reminder" | "check";
export type FollowupStatus = "pending" | "done" | "cancelled";
export type FollowupSource = "chat" | "reflection";

export type FollowupRecord = {
	id: string;
	userId: string;
	botId: string;
	conversationId: string | null;
	dueAt: Date;
	requestedFor: Date;
	/** Avisos do lembrete (sempre ao menos um); dueAt é o próximo pendente. */
	stages: FollowupStage[];
	note: string;
	kind: FollowupKind;
	status: FollowupStatus;
	source: FollowupSource;
	runId: string | null;
	attempts: number;
	createdAt: Date;
};

type FollowupRow = Prisma.BotFollowupGetPayload<Record<string, never>>;

function toFollowup(row: FollowupRow): FollowupRecord {
	return {
		id: row.id,
		userId: row.userId,
		botId: row.botId,
		conversationId: row.conversationId,
		dueAt: row.dueAt,
		requestedFor: row.requestedFor,
		stages: parseFollowupStages(row.stages, row.dueAt, row.status === "done"),
		note: row.note,
		kind: row.kind === "check" ? "check" : "reminder",
		status: row.status === "done" || row.status === "cancelled" ? row.status : "pending",
		source: row.source === "reflection" ? "reflection" : "chat",
		runId: row.runId,
		attempts: row.attempts,
		createdAt: row.createdAt,
	};
}

export class FollowupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FollowupError";
	}
}

async function ownedBot(userId: string, botId: string) {
	if (!userId.trim() || userId === "default") return null;
	return prisma.bot.findFirst({
		where: { id: botId, ownerId: userId },
		select: { id: true, ownerId: true, isPrimary: true, conversationId: true, policyJson: true, openRouterModel: true, name: true },
	});
}

/**
 * Agenda um lembrete. `dueAt` já vem resolvido (e empurrado para fora do silêncio) por
 * quem chama. Devolve o existente quando é o mesmo lembrete no mesmo horário.
 */
export async function createFollowup(input: {
	userId: string;
	botId: string;
	note: string;
	kind: FollowupKind;
	dueAt: Date;
	requestedFor: Date;
	/** Horários de todos os avisos (já fora do silêncio). Sem isso, um aviso só em `dueAt`. */
	stages?: Date[];
	source: FollowupSource;
	sourceRunId?: string | null;
}): Promise<{ followup: FollowupRecord; duplicate: boolean }> {
	const bot = await ownedBot(input.userId, input.botId);
	if (!bot) throw new FollowupError("Bot não encontrado");
	if (!bot.isPrimary) throw new FollowupError("Disponível só no bot principal");
	const note = input.note.trim().slice(0, FOLLOWUP_NOTE_MAX_CHARS);
	if (!note) throw new FollowupError("note vazio");
	const pending = await prisma.botFollowup.findMany({
		where: { botId: bot.id, userId: input.userId, status: "pending" },
		orderBy: { dueAt: "asc" },
	});
	const dates = input.stages && input.stages.length > 0 ? normalizeNewStages(input.stages) : [input.dueAt];
	const first = dates[0]!;
	const same = findDuplicateFollowup(pending, { note, dueAt: first });
	if (same) return { followup: toFollowup(same), duplicate: true };
	if (pending.length >= FOLLOWUP_MAX_PENDING) {
		throw new FollowupError(`limite de ${FOLLOWUP_MAX_PENDING} lembretes pendentes; cancele algum antes`);
	}
	const row = await prisma.botFollowup.create({
		data: {
			userId: input.userId,
			botId: bot.id,
			conversationId: bot.conversationId,
			dueAt: first,
			requestedFor: input.requestedFor,
			stages: dates.map((at) => ({ at: at.toISOString(), firedAt: null })),
			note,
			kind: input.kind,
			source: input.source,
			sourceRunId: input.sourceRunId ?? null,
		},
	});
	return { followup: toFollowup(row), duplicate: false };
}

export async function listFollowups(
	userId: string,
	botId: string,
	options: { status?: FollowupStatus; limit?: number } = {},
): Promise<FollowupRecord[]> {
	if (!userId.trim() || userId === "default") return [];
	const rows = await prisma.botFollowup.findMany({
		where: { userId, botId, status: options.status ?? "pending" },
		orderBy: { dueAt: "asc" },
		take: Math.min(100, options.limit ?? 50),
	});
	return rows.map(toFollowup);
}

/** Cancela um lembrete pendente do dono. `false` = não existe, não é dele ou já não está pendente. */
export async function cancelFollowup(userId: string, followupId: string, botId?: string): Promise<boolean> {
	if (!userId.trim() || userId === "default") return false;
	const result = await prisma.botFollowup.updateMany({
		where: { id: followupId, userId, status: "pending", ...(botId ? { botId } : {}) },
		data: { status: "cancelled", doneAt: new Date(), claimedUntil: null },
	});
	return result.count === 1;
}

export type RescheduleOwnedResult =
	| { ok: true; followup: FollowupRecord; movedForQuietHours: boolean; requestedFor: Date }
	| { ok: false; status: 400 | 404; error: string };

/**
 * Muda o horário de um lembrete pendente do dono. `when` é lido no fuso da conta (ISO sem fuso
 * ou texto como "amanhã 9h"); passado é recusado e o silêncio empurra para o fim dele.
 */
export async function rescheduleOwnedFollowup(input: {
	userId: string;
	botId: string;
	followupId: string;
	when: string;
	/** Aviso a mover (1 = primeiro). Sem isso, o próximo pendente. */
	stage?: number;
	now?: Date;
}): Promise<RescheduleOwnedResult> {
	const notFound = { ok: false, status: 404, error: "Lembrete não encontrado ou já concluído." } as const;
	if (!input.userId.trim() || input.userId === "default") return notFound;
	const bot = await ownedBot(input.userId, input.botId);
	if (!bot) return notFound;
	const row = await prisma.botFollowup.findFirst({
		where: { id: input.followupId, userId: input.userId, botId: bot.id, status: "pending" },
	});
	if (!row) return notFound;
	const settings = readProactiveSettings(bot.policyJson, await accountTimezoneOf(input.userId));
	const plan = planFollowupReschedule({ when: input.when, now: input.now ?? new Date(), settings });
	if (!plan.ok) return { ok: false, status: 400, error: plan.error };
	const current = parseFollowupStages(row.stages, row.dueAt);
	const nextIndex = nextPendingStageIndex(current);
	const index = input.stage === undefined ? nextIndex : input.stage - 1;
	const stages = setFollowupStageAt(current, index, plan.dueAt);
	if (!stages) return { ok: false, status: 400, error: "Esse aviso já saiu ou não existe." };
	const due = new Date(stages[nextPendingStageIndex(stages)]!.at);
	const movedNext = index === nextIndex;
	const data = { dueAt: due, ...(movedNext ? { requestedFor: plan.requestedFor } : {}), stages, claimedUntil: null, attempts: 0, lastError: null };
	const result = await prisma.botFollowup.updateMany({
		where: { id: row.id, userId: input.userId, status: "pending" },
		data,
	});
	if (result.count !== 1) return notFound;
	return {
		ok: true,
		followup: toFollowup({ ...row, ...data }),
		movedForQuietHours: plan.movedForQuietHours,
		requestedFor: plan.requestedFor,
	};
}

/** Reserva lembretes vencidos (um worker por linha, mesmo com vários processos). */
export async function claimDueFollowups(now: Date, limit = SWEEP_BATCH): Promise<FollowupRecord[]> {
	const claimUntil = new Date(now.getTime() + FOLLOWUP_CLAIM_MS);
	const rows = await prisma.$queryRaw<FollowupRow[]>`
		UPDATE "bot_followups" SET "claimedUntil" = ${claimUntil}, "updatedAt" = ${now}
		WHERE "id" IN (
			SELECT "id" FROM "bot_followups"
			WHERE "status" = 'pending' AND "dueAt" <= ${now}
			  AND ("claimedUntil" IS NULL OR "claimedUntil" <= ${now})
			ORDER BY "dueAt" ASC
			LIMIT ${limit}
			FOR UPDATE SKIP LOCKED
		)
		RETURNING *`;
	return rows.map(toFollowup);
}

export async function completeFollowup(id: string, runId: string | null, now = new Date()): Promise<void> {
	await prisma.botFollowup.updateMany({
		where: { id, status: "pending" },
		data: { status: "done", runId, doneAt: now, claimedUntil: null, lastError: null },
	});
}

/**
 * Um aviso saiu: marca-o como enviado e, se houver outro, volta o lembrete à fila no horário dele.
 * Só encerra (done) depois do último aviso. Devolve se ainda restam avisos.
 */
export async function fireFollowupStage(followup: FollowupRecord, runId: string | null, now = new Date()): Promise<{ remaining: boolean }> {
	const advanced = advanceFollowupStages(followup.stages, now);
	if (!advanced.nextDueAt) {
		await prisma.botFollowup.updateMany({
			where: { id: followup.id, status: "pending" },
			data: { status: "done", runId, doneAt: now, claimedUntil: null, lastError: null, stages: advanced.stages },
		});
		return { remaining: false };
	}
	await prisma.botFollowup.updateMany({
		where: { id: followup.id, status: "pending" },
		data: { dueAt: advanced.nextDueAt, runId, claimedUntil: null, attempts: 0, lastError: null, stages: advanced.stages },
	});
	return { remaining: true };
}

/** Devolve o lembrete à fila com novo horário (ocupado, silêncio, teto ou falha). */
export async function rescheduleFollowup(
	id: string,
	input: { dueAt: Date; error?: string; countAttempt?: boolean },
): Promise<void> {
	await prisma.botFollowup.updateMany({
		where: { id, status: "pending" },
		data: {
			dueAt: input.dueAt,
			claimedUntil: null,
			...(input.countAttempt ? { attempts: { increment: 1 } } : {}),
			...(input.error ? { lastError: input.error.slice(0, 300) } : {}),
		},
	});
}

export async function abandonFollowup(id: string, error: string, now = new Date()): Promise<void> {
	await prisma.botFollowup.updateMany({
		where: { id, status: "pending" },
		data: { status: "cancelled", doneAt: now, claimedUntil: null, lastError: error.slice(0, 300) },
	});
}

// ---------------------------------------------------------------------------
// Eventos (teto diário e reflexão do dia)
// ---------------------------------------------------------------------------

export type ProactiveEventKind = "reflection" | "message" | "followup" | "routine";

export async function recordProactiveEvent(input: {
	userId: string;
	botId: string;
	kind: ProactiveEventKind;
	runId?: string | null;
	detail?: string;
}): Promise<void> {
	await prisma.proactiveEvent.create({
		data: {
			userId: input.userId,
			botId: input.botId,
			kind: input.kind,
			runId: input.runId ?? null,
			detail: input.detail?.slice(0, 80) ?? null,
		},
	});
}

export async function countProactiveEvents(
	botId: string,
	kind: ProactiveEventKind,
	window: { start: Date; end: Date },
): Promise<number> {
	return prisma.proactiveEvent.count({ where: { botId, kind, createdAt: { gte: window.start, lt: window.end } } });
}

export async function lastProactiveEventAt(botId: string, kind: ProactiveEventKind): Promise<Date | null> {
	const row = await prisma.proactiveEvent.findFirst({
		where: { botId, kind },
		orderBy: { createdAt: "desc" },
		select: { createdAt: true },
	});
	return row?.createdAt ?? null;
}

/**
 * Reserva uma mensagem proativa do dia: confere silêncio e teto e grava o evento na MESMA
 * transação (trava por bot), então dois envios simultâneos não passam do limite.
 */
export async function reserveProactiveMessage(input: {
	userId: string;
	botId: string;
	settings: ProactiveSettings;
	now?: Date;
	runId?: string | null;
	detail?: string;
}): Promise<ProactiveGate> {
	const now = input.now ?? new Date();
	return prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`proactive:${input.botId}`}))`;
		const window = localDayWindow(now, input.settings.timezone);
		const sentToday = await tx.proactiveEvent.count({
			where: { botId: input.botId, kind: "message", createdAt: { gte: window.start, lt: window.end } },
		});
		const gate = checkProactiveGate({ now, settings: input.settings, sentToday });
		if (gate.allowed) {
			await tx.proactiveEvent.create({
				data: {
					userId: input.userId,
					botId: input.botId,
					kind: "message",
					createdAt: now,
					runId: input.runId ?? null,
					detail: input.detail?.slice(0, 80) ?? null,
				},
			});
		}
		return gate;
	});
}

/** Reserva a reflexão do dia (uma por dia local, mesmo com vários workers). `false` = já reservada. */
async function claimDailyReflection(input: { userId: string; botId: string; settings: ProactiveSettings; now: Date }): Promise<boolean> {
	return prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`proactive-reflection:${input.botId}`}))`;
		const window = localDayWindow(input.now, input.settings.timezone);
		const already = await tx.proactiveEvent.count({
			where: { botId: input.botId, kind: "reflection", createdAt: { gte: window.start, lt: window.end } },
		});
		if (already > 0) return false;
		await tx.proactiveEvent.create({
			data: { userId: input.userId, botId: input.botId, kind: "reflection", detail: "started", createdAt: input.now },
		});
		return true;
	});
}

// ---------------------------------------------------------------------------
// Contexto da reflexão
// ---------------------------------------------------------------------------

const RECENT_MESSAGES_LIMIT = 14;

export async function loadRecentChatTail(
	conversationId: string | null,
	limit: number,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
	if (!conversationId) return [];
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: { in: ["user", "assistant"] } },
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: limit,
		select: { role: true, content: true },
	});
	return rows
		.reverse()
		.map((row) => ({ role: row.role === "user" ? ("user" as const) : ("assistant" as const), content: row.content }));
}

export async function loadReflectionContext(input: {
	userId: string;
	botId: string;
	botName: string;
	conversationId: string | null;
}): Promise<ReflectionContext> {
	const [memory, summary, recentMessages, routines, followups, connections] = await Promise.all([
		getMemorySnapshot(input.userId, input.botId).catch(() => null),
		input.conversationId ? getLatestSummary(input.conversationId).catch(() => null) : Promise.resolve(null),
		loadRecentChatTail(input.conversationId, RECENT_MESSAGES_LIMIT),
		prisma.routine.findMany({
			where: { userId: input.userId, botId: input.botId },
			orderBy: { createdAt: "desc" },
			take: 40,
			select: { name: true, schedule: true, enabled: true, createdBy: true, triggerType: true },
		}),
		listFollowups(input.userId, input.botId, { limit: 40 }),
		listConnectedMcpConnections(input.userId).catch(() => []),
	]);
	return {
		botName: input.botName,
		userMemory: memory?.user.entries.map((entry) => entry.content) ?? [],
		botMemory: memory?.memory.entries.map((entry) => entry.content) ?? [],
		summary: summary?.content ?? null,
		recentMessages,
		routines: routines.map((row) => ({
			name: row.name,
			schedule: row.schedule ?? (row.triggerType === "cron" ? null : row.triggerType),
			enabled: row.enabled,
			createdBy: row.createdBy === "bot" ? "bot" : "user",
		})),
		followups: followups.map((item) => ({ note: item.note, dueAt: item.dueAt, kind: item.kind })),
		connectors: connections.map((connection) => connection.name),
	};
}

// ---------------------------------------------------------------------------
// Varredura (worker)
// ---------------------------------------------------------------------------

export type ProactiveDeps = {
	/** Enfileira o job do run (worker); `false` = a reconciliação de runs `queued` repete. */
	enqueueRun: (runId: string) => Promise<boolean>;
	/** Modelo padrão quando nem o bot nem a conta definem. */
	envDefaultModel: string;
	now?: () => Date;
	/** Injetáveis em teste; padrão: db. */
	createRun?: typeof createAgentRun;
	createDetachedRun?: typeof createDetachedProactiveRun;
	activeRuns?: typeof listActiveRunsForConversation;
	resolveModel?: (botId: string, userId: string, envDefault: string) => Promise<string>;
	log?: (line: string) => void;
};

export type ProactiveSweepResult = {
	followupsRun: number;
	followupsDeferred: number;
	followupsAbandoned: number;
	reflections: number;
};

async function resolveProactiveModel(botId: string, userId: string, envDefault: string): Promise<string> {
	const override = process.env.ATLAS_PROACTIVE_MODEL?.trim();
	if (override) return override;
	const botModel = await getBotModelForUser(botId, userId);
	const accountDefault = botModel ? undefined : (await getAccountConfig(userId).catch(() => null))?.models?.default;
	return pickEffectiveModel({ botModel, envDefault: accountDefault ?? envDefault });
}

/** Run da reflexão: sem conversa (não disputa a vez com o chat e não grava texto solto). */
export async function createDetachedProactiveRun(input: {
	userId: string;
	botId: string;
	model: string;
	objective: string;
	messages: Array<{ role: "user" | "system" | "assistant"; content: string }>;
	/** Teto de passos do run (padrão do runtime quando ausente). */
	maxSteps?: number;
}) {
	const bot = await prisma.bot.findFirst({ where: { id: input.botId, ownerId: input.userId }, select: { id: true } });
	if (!bot) throw new FollowupError("Bot não encontrado");
	return prisma.agentRun.create({
		data: buildQueuedRunData({
			request: { botId: input.botId, origin: "proactive", objective: input.objective, messages: input.messages, silent: true, ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}) },
			model: input.model,
			userId: input.userId,
			conversationId: null,
		}),
	});
}

type PrimaryBotRow = {
	id: string;
	ownerId: string;
	name: string;
	conversationId: string | null;
	policyJson: unknown;
};

async function loadPrimaryBot(userId: string, botId: string): Promise<PrimaryBotRow | null> {
	const row = await prisma.bot.findFirst({
		where: { id: botId, ownerId: userId, isPrimary: true },
		select: { id: true, ownerId: true, name: true, conversationId: true, policyJson: true },
	});
	return row && row.ownerId ? { ...row, ownerId: row.ownerId } : null;
}

/** Fuso das configurações da conta (o padrão do modo proativo); sem valor ou com falha, o do bot vale. */
async function accountTimezoneOf(userId: string): Promise<string | undefined> {
	return (await getAccountConfig(userId).catch(() => null))?.general?.timezone;
}

async function dispatchFollowup(followup: FollowupRecord, deps: ProactiveDeps, now: Date, result: ProactiveSweepResult): Promise<void> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const bot = await loadPrimaryBot(followup.userId, followup.botId);
	if (!bot || !bot.conversationId) {
		await abandonFollowup(followup.id, "bot indisponível", now);
		result.followupsAbandoned += 1;
		log(`[proactive] followup=${followup.id} abandoned reason=no_primary_bot`);
		return;
	}
	const settings = readProactiveSettings(bot.policyJson, await accountTimezoneOf(bot.ownerId));
	// Silêncio vale para tudo; o teto diário só para o que o bot decidiu sozinho.
	const quiet = nextAllowedTime(now, settings);
	if (quiet.getTime() > now.getTime()) {
		await rescheduleFollowup(followup.id, { dueAt: quiet });
		result.followupsDeferred += 1;
		log(`[proactive] followup=${followup.id} deferred reason=quiet_hours`);
		return;
	}
	if (followup.source === "reflection") {
		const window = localDayWindow(now, settings.timezone);
		const sent = await countProactiveEvents(bot.id, "message", window);
		if (sent >= settings.maxPerDay) {
			await rescheduleFollowup(followup.id, { dueAt: window.end });
			result.followupsDeferred += 1;
			log(`[proactive] followup=${followup.id} deferred reason=daily_cap`);
			return;
		}
	}
	const activeRuns = deps.activeRuns ?? listActiveRunsForConversation;
	if ((await activeRuns(bot.conversationId)).length > 0) {
		await rescheduleFollowup(followup.id, { dueAt: new Date(now.getTime() + FOLLOWUP_BUSY_RETRY_MS) });
		result.followupsDeferred += 1;
		log(`[proactive] followup=${followup.id} deferred reason=bot_busy`);
		return;
	}
	try {
		const tail = await loadRecentChatTail(bot.conversationId, 6);
		const prompt = buildFollowupPrompt({
			note: followup.note,
			kind: followup.kind,
			requestedFor: followup.requestedFor,
			settings,
			now,
			recentMessages: tail,
		});
		const model = await (deps.resolveModel ?? resolveProactiveModel)(bot.id, followup.userId, deps.envDefaultModel);
		const run = await (deps.createRun ?? createAgentRun)({
			userId: followup.userId,
			model,
			request: {
				botId: bot.id,
				conversationId: bot.conversationId,
				origin: "proactive",
				objective: prompt,
				messages: [{ role: "user", content: prompt }],
				silent: true,
			},
		});
		// Corrida: um run ativo entrou na conversa entre a checagem e o create.
		if (run.origin !== "proactive" || run.objective !== prompt.trim()) {
			await rescheduleFollowup(followup.id, { dueAt: new Date(now.getTime() + FOLLOWUP_BUSY_RETRY_MS) });
			result.followupsDeferred += 1;
			log(`[proactive] followup=${followup.id} deferred reason=bot_busy_race`);
			return;
		}
		await fireFollowupStage(followup, run.id, now);
		if (followup.source === "reflection") {
			await recordProactiveEvent({ userId: followup.userId, botId: bot.id, kind: "message", runId: run.id, detail: "followup" });
		}
		await recordProactiveEvent({ userId: followup.userId, botId: bot.id, kind: "followup", runId: run.id, detail: followup.kind });
		const enqueued = await deps.enqueueRun(run.id).catch(() => false);
		result.followupsRun += 1;
		log(`[proactive] followup=${followup.id} run=${run.id} kind=${followup.kind} source=${followup.source} enqueued=${enqueued}`);
	} catch (error) {
		const attempts = followup.attempts + 1;
		const message = error instanceof Error ? error.message : "falha ao criar o run";
		if (attempts >= FOLLOWUP_MAX_ATTEMPTS) {
			await abandonFollowup(followup.id, message, now);
			result.followupsAbandoned += 1;
			log(`[proactive] followup=${followup.id} abandoned reason=attempts`);
			return;
		}
		await rescheduleFollowup(followup.id, {
			dueAt: new Date(now.getTime() + FOLLOWUP_ERROR_RETRY_MS),
			error: message,
			countAttempt: true,
		});
		result.followupsDeferred += 1;
		log(`[proactive] followup=${followup.id} deferred reason=error attempts=${attempts}`);
	}
}

async function runReflection(
	bot: PrimaryBotRow,
	settings: ProactiveSettings,
	deps: ProactiveDeps,
	now: Date,
	result: ProactiveSweepResult,
): Promise<void> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const claimed = await claimDailyReflection({ userId: bot.ownerId, botId: bot.id, settings, now });
	if (!claimed) return;
	try {
		const window = localDayWindow(now, settings.timezone);
		const [context, sentToday] = await Promise.all([
			loadReflectionContext({ userId: bot.ownerId, botId: bot.id, botName: bot.name, conversationId: bot.conversationId }),
			countProactiveEvents(bot.id, "message", window),
		]);
		const prompt = buildReflectionPrompt({ context, settings, sentToday, now });
		const model = await (deps.resolveModel ?? resolveProactiveModel)(bot.id, bot.ownerId, deps.envDefaultModel);
		const run = await (deps.createDetachedRun ?? createDetachedProactiveRun)({
			userId: bot.ownerId,
			botId: bot.id,
			model,
			objective: prompt,
			messages: [{ role: "user", content: prompt }],
		});
		const enqueued = await deps.enqueueRun(run.id).catch(() => false);
		result.reflections += 1;
		log(
			`[proactive] reflection bot=${bot.id} run=${run.id} enqueued=${enqueued} routines=${context.routines.length} followups=${context.followups.length} sentToday=${sentToday}`,
		);
	} catch (error) {
		log(`[proactive] reflection bot=${bot.id} failed: ${error instanceof Error ? error.message : "erro"}`);
	}
}

/** Bots principais com o modo proativo ligado. */
export async function listProactiveBots(): Promise<PrimaryBotRow[]> {
	const rows = await prisma.bot.findMany({
		where: { isPrimary: true, ownerId: { not: null }, policyJson: { path: ["proactive", "enabled"], equals: true } },
		select: { id: true, ownerId: true, name: true, conversationId: true, policyJson: true },
	});
	return rows.flatMap((row) => (row.ownerId ? [{ ...row, ownerId: row.ownerId }] : []));
}

/**
 * Uma passada do worker: dispara lembretes vencidos e a reflexão diária dos bots com o
 * modo proativo ligado. Nunca lança por causa de um item; devolve contagens.
 */
export async function processProactive(deps: ProactiveDeps): Promise<ProactiveSweepResult> {
	const now = (deps.now ?? (() => new Date()))();
	const result: ProactiveSweepResult = { followupsRun: 0, followupsDeferred: 0, followupsAbandoned: 0, reflections: 0 };
	const due = await claimDueFollowups(now, SWEEP_BATCH);
	for (const followup of due) {
		try {
			await dispatchFollowup(followup, deps, now, result);
		} catch (error) {
			(deps.log ?? console.error)(`[proactive] followup=${followup.id} sweep error: ${error instanceof Error ? error.message : "erro"}`);
		}
	}
	for (const bot of await listProactiveBots()) {
		const settings = readProactiveSettings(bot.policyJson, await accountTimezoneOf(bot.ownerId));
		const last = await lastProactiveEventAt(bot.id, "reflection");
		if (!isReflectionDue({ now, settings, botId: bot.id, lastReflectionAt: last })) continue;
		await runReflection(bot, settings, deps, now, result);
	}
	return result;
}

/** Conversa do bot (o card e a mensagem proativa caem nela). */
export async function getBotConversationId(botId: string, userId: string): Promise<string | null> {
	if (!userId.trim() || userId === "default") return null;
	const row = await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { conversationId: true } });
	return row?.conversationId ?? null;
}
