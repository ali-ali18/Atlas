import { emitCodingFailed } from "./user-needed.js";
import { Prisma } from "@prisma/client";
import type { DevSessionPreview } from "@workspace/shared";
import { prisma } from "./client.js";

export const DEV_SESSION_STATUSES = ["CREATING", "QUEUED", "RUNNING", "IDLE", "STOPPED", "EXPIRED", "ERROR"] as const;
export type DevSessionStatus = (typeof DEV_SESSION_STATUSES)[number];
export const DEV_SESSION_TIERS = ["small", "medium", "large"] as const;
export type DevSessionTier = (typeof DEV_SESSION_TIERS)[number];

export type DevTodoItem = {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
};

export type DevSessionPr = {
	number: number;
	url: string;
	state: "open" | "draft" | "merged" | "closed";
	base: string;
	head: string;
	headSha: string | null;
	title: string;
};

export type DevSessionRecord = {
	pr: DevSessionPr | null;
	id: string;
	userId: string;
	conversationId: string | null;
	repo: string | null;
	branch: string | null;
	baseBranch: string | null;
	status: DevSessionStatus;
	tier: DevSessionTier;
	containerId: string | null;
	todos: DevTodoItem[];
	lastError: string | null;
	/** Prévia privada ativa (ver `previews` na API); `null` = nenhuma. */
	preview: DevSessionPreview | null;
	createdAt: Date;
	updatedAt: Date;
	lastActiveAt: Date;
};

type Row = Prisma.DevSessionGetPayload<Record<string, never>>;

const PR_STATES = ["open", "draft", "merged", "closed"] as const;

function toPr(row: Row): DevSessionPr | null {
	if (row.prNumber == null || !row.prUrl) return null;
	return {
		number: row.prNumber,
		url: row.prUrl,
		state: (PR_STATES as readonly string[]).includes(row.prState ?? "") ? (row.prState as DevSessionPr["state"]) : "open",
		base: row.prBase ?? "",
		head: row.prHead ?? "",
		headSha: row.prHeadSha,
		title: row.prTitle ?? "",
	};
}

export function parsePreview(value: unknown): DevSessionPreview | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.port !== "number" || typeof v.path !== "string" || typeof v.startedAt !== "string" || typeof v.expiresAt !== "string") return null;
	return { port: v.port, path: v.path, startedAt: v.startedAt, expiresAt: v.expiresAt, ...(v.basePrefixed === true ? { basePrefixed: true } : {}), ...(typeof v.cap === "string" && v.cap ? { cap: v.cap } : {}), ...(typeof v.capIssuedAt === "string" ? { capIssuedAt: v.capIssuedAt } : {}) };
}

function toRecord(row: Row): DevSessionRecord {
	return {
		pr: toPr(row),
		id: row.id,
		userId: row.userId,
		conversationId: row.conversationId,
		repo: row.repo,
		branch: row.branch,
		baseBranch: row.baseBranch,
		status: (DEV_SESSION_STATUSES as readonly string[]).includes(row.status) ? (row.status as DevSessionStatus) : "ERROR",
		tier: (DEV_SESSION_TIERS as readonly string[]).includes(row.tier) ? (row.tier as DevSessionTier) : "small",
		containerId: row.containerId,
		todos: Array.isArray(row.todos) ? (row.todos as DevTodoItem[]) : [],
		lastError: row.lastError,
		preview: parsePreview(row.preview),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		lastActiveAt: row.lastActiveAt,
	};
}

export async function createDevSession(input: {
	userId: string;
	conversationId?: string | null;
	repo?: string | null;
	branch?: string | null;
	baseBranch?: string | null;
	tier?: DevSessionTier;
	status?: DevSessionStatus;
}): Promise<DevSessionRecord> {
	const row = await prisma.devSession.create({
		data: {
			userId: input.userId,
			conversationId: input.conversationId ?? null,
			repo: input.repo ?? null,
			branch: input.branch ?? null,
			baseBranch: input.baseBranch ?? null,
			tier: input.tier ?? "small",
			status: input.status ?? "CREATING",
		},
	});
	return toRecord(row);
}

export async function getDevSession(id: string, userId: string): Promise<DevSessionRecord | null> {
	const row = await prisma.devSession.findFirst({ where: { id, userId } });
	return row ? toRecord(row) : null;
}

/** Sessão por id, sem escopo de usuário: só para rotas internas que se autenticam por outro meio (callback do container). */
export async function getDevSessionById(id: string): Promise<DevSessionRecord | null> {
	const row = await prisma.devSession.findUnique({ where: { id } });
	return row ? toRecord(row) : null;
}

/** Sessão mais recente da conversa que ainda pode ser usada (não expirada/com erro). */
export async function getActiveDevSessionForConversation(
	conversationId: string,
	userId: string,
): Promise<DevSessionRecord | null> {
	const row = await prisma.devSession.findFirst({
		where: { conversationId, userId, status: { notIn: ["EXPIRED", "ERROR"] } },
		orderBy: { createdAt: "desc" },
	});
	return row ? toRecord(row) : null;
}

export async function updateDevSession(
	id: string,
	patch: Partial<{
		status: DevSessionStatus;
		tier: DevSessionTier;
		repo: string | null;
		branch: string | null;
		baseBranch: string | null;
		containerId: string | null;
		lastError: string | null;
		todos: DevTodoItem[];
		/** `null` limpa o PR da sessão. */
		pr: DevSessionPr | null;
		/** `null` encerra a prévia. */
		preview: DevSessionPreview | null;
		touch: boolean;
	}>,
): Promise<void> {
	const { touch, todos, pr, preview, ...rest } = patch;
	const row = await prisma.devSession.update({
		where: { id },
		data: {
			...rest,
			...(pr === undefined
				? {}
				: pr === null
					? { prNumber: null, prUrl: null, prState: null, prBase: null, prHead: null, prHeadSha: null, prTitle: null }
					: { prNumber: pr.number, prUrl: pr.url, prState: pr.state, prBase: pr.base, prHead: pr.head, prHeadSha: pr.headSha, prTitle: pr.title }),
			...(preview === undefined ? {} : { preview: preview === null ? Prisma.DbNull : (preview as unknown as Prisma.InputJsonValue) }),
			...(todos ? { todos: todos as unknown as Prisma.InputJsonValue } : {}),
			...(touch ? { lastActiveAt: new Date() } : {}),
		},
	});
	// Sessão de código falhou: avisa o usuário (uma vez por transição para ERROR).
	if (patch.status === "ERROR" && row.conversationId) {
		const reason = patch.lastError ?? row.lastError ?? "";
		emitCodingFailed({ conversationId: row.conversationId as string, userId: row.userId as string, detail: reason });
	}
}

/** Sessões em RUNNING sem atividade desde `before` (candidatas a parar). */
export async function listIdleDevSessions(before: Date, limit = 50): Promise<DevSessionRecord[]> {
	const rows = await prisma.devSession.findMany({
		where: { status: { in: ["RUNNING", "IDLE"] }, lastActiveAt: { lt: before } },
		orderBy: { lastActiveAt: "asc" },
		take: limit,
	});
	return rows.map(toRecord);
}

/** Sessões paradas desde `before` (candidatas a expirar: remover container e volume). */
export async function listStoppedDevSessionsBefore(before: Date, limit = 50): Promise<DevSessionRecord[]> {
	const rows = await prisma.devSession.findMany({
		where: { status: "STOPPED", lastActiveAt: { lt: before } },
		orderBy: { lastActiveAt: "asc" },
		take: limit,
	});
	return rows.map(toRecord);
}

export async function listQueuedDevSessions(limit = 20): Promise<DevSessionRecord[]> {
	const rows = await prisma.devSession.findMany({
		where: { status: "QUEUED" },
		orderBy: { createdAt: "asc" },
		take: limit,
	});
	return rows.map(toRecord);
}

export async function listDevSessionsForConversation(conversationId: string, userId: string): Promise<DevSessionRecord[]> {
	const rows = await prisma.devSession.findMany({
		where: { conversationId, userId },
		orderBy: { createdAt: "desc" },
		take: 50,
	});
	return rows.map(toRecord);
}

export type DevSessionStats = {
	commandsRun: number;
	filesChanged: Array<{ path: string; added: number; removed: number }>;
	totalAdded: number;
	totalRemoved: number;
	lastActivityAt: string | null;
};

type StatRow = { type: string; payload: unknown; createdAt: Date };

/** Agrega os eventos persistidos da sessão (puro; o filtro por `sessionId` já foi feito). */
export function aggregateDevSessionEvents(rows: readonly StatRow[]): DevSessionStats {
	let commandsRun = 0;
	let last: Date | null = null;
	const files = new Map<string, { added: number; removed: number }>();
	for (const row of rows) {
		if (!last || row.createdAt > last) last = row.createdAt;
		const payload = (row.payload ?? {}) as { path?: unknown; added?: unknown; removed?: unknown };
		if (row.type === "shell_started") commandsRun += 1;
		if (row.type === "file_edit" && typeof payload.path === "string") {
			const entry = files.get(payload.path) ?? { added: 0, removed: 0 };
			entry.added += Number(payload.added) || 0;
			entry.removed += Number(payload.removed) || 0;
			files.set(payload.path, entry);
		}
	}
	const filesChanged = [...files].map(([path, v]) => ({ path, ...v }));
	return {
		commandsRun,
		filesChanged,
		totalAdded: filesChanged.reduce((n, f) => n + f.added, 0),
		totalRemoved: filesChanged.reduce((n, f) => n + f.removed, 0),
		lastActivityAt: last ? last.toISOString() : null,
	};
}

/** Contadores da sessão a partir dos run_events da conversa que citam o `sessionId`. */
export async function getDevSessionStats(session: Pick<DevSessionRecord, "id" | "conversationId">): Promise<DevSessionStats> {
	if (!session.conversationId) return aggregateDevSessionEvents([]);
	const rows = await prisma.runEvent.findMany({
		where: {
			type: { in: ["shell_started", "file_edit"] },
			payload: { path: ["sessionId"], equals: session.id },
			run: { conversationId: session.conversationId },
		},
		select: { type: true, payload: true, createdAt: true },
		orderBy: { createdAt: "asc" },
		take: 5000,
	});
	return aggregateDevSessionEvents(rows);
}

// ---------------------------------------------------------------------------
// Histórico persistido, run de destino dos eventos da API e lista "Em andamento"
// ---------------------------------------------------------------------------

export type DevHistoryEventRow = {
	id: string;
	runId: string;
	seq: number;
	type: string;
	payload: Record<string, unknown>;
	createdAt: string;
};

const HISTORY_STRUCT_TYPES = ["dev_session_status", "dev_setup_step", "shell_started", "shell_done", "file_edit", "todo_updated", "dev_pr", "dev_ci", "context_compacted", "context_usage", "dev_timing"];

function sessionPayloadFilter(sessionId: string) {
	return { path: ["sessionId"], equals: sessionId } as const;
}

function toHistoryRow(row: { id: string; runId: string; seq: number; type: string; payload: unknown; createdAt: Date }): DevHistoryEventRow {
	return {
		id: row.id,
		runId: row.runId,
		seq: row.seq,
		type: row.type,
		payload: (row.payload ?? {}) as Record<string, unknown>,
		createdAt: row.createdAt.toISOString(),
	};
}

/**
 * Eventos persistidos da sessão (run_events da conversa que citam o `sessionId`),
 * em ordem cronológica. Estrutura (status, comandos, diffs, tarefas) vem inteira;
 * a saída de shell vem dos blocos mais recentes (o corte final por comando é
 * feito por `capHistoryShellOutput`). `after` = data do último evento já conhecido.
 */
export async function listDevSessionHistory(
	session: Pick<DevSessionRecord, "id" | "conversationId">,
	options: { after?: Date; structLimit?: number; outputLimit?: number } = {},
): Promise<DevHistoryEventRow[]> {
	if (!session.conversationId) return [];
	const base = {
		payload: sessionPayloadFilter(session.id),
		run: { conversationId: session.conversationId },
		...(options.after ? { createdAt: { gt: options.after } } : {}),
	};
	const [structural, output] = await Promise.all([
		prisma.runEvent.findMany({
			where: { ...base, type: { in: HISTORY_STRUCT_TYPES } },
			orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
			take: options.structLimit ?? 3000,
		}),
		prisma.runEvent.findMany({
			where: { ...base, type: "shell_output" },
			orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
			take: options.outputLimit ?? 4000,
		}),
	]);
	return mergeHistoryRows([...structural, ...output.reverse()].map(toHistoryRow));
}

/** Ordena por tempo (e `seq` dentro do mesmo run). Puro, exportado para teste. */
export function mergeHistoryRows(rows: DevHistoryEventRow[]): DevHistoryEventRow[] {
	return [...rows].sort((a, b) => {
		const t = Date.parse(a.createdAt) - Date.parse(b.createdAt);
		if (t !== 0) return t;
		if (a.runId === b.runId) return a.seq - b.seq;
		return a.runId < b.runId ? -1 : 1;
	});
}

/** `callId` do comando que usa este `jobId` (para o evento de encerramento feito pela API). */
export async function findDevSessionJob(
	session: Pick<DevSessionRecord, "id" | "conversationId">,
	jobId: string,
): Promise<{ callId: string; startedAt: string | null } | null> {
	if (!session.conversationId) return null;
	const rows = await prisma.runEvent.findMany({
		where: {
			type: "shell_started",
			AND: [{ payload: sessionPayloadFilter(session.id) }, { payload: { path: ["jobId"], equals: jobId } }],
			run: { conversationId: session.conversationId },
		},
		orderBy: { createdAt: "desc" },
		take: 1,
		select: { payload: true },
	});
	const payload = rows[0]?.payload as { callId?: unknown; startedAt?: unknown } | undefined;
	if (!payload || typeof payload.callId !== "string") return null;
	return { callId: payload.callId, startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null };
}

/**
 * Eventos `shell_started`/`shell_done` da sessão em ordem cronológica (insumo de `computeOpenDevJobs`:
 * quais comandos ainda não têm fim registrado).
 */
export async function listDevSessionJobEvents(
	session: Pick<DevSessionRecord, "id" | "conversationId">,
): Promise<Array<{ type: string; payload: unknown; createdAt: Date }>> {
	if (!session.conversationId) return [];
	const rows = await prisma.runEvent.findMany({
		where: {
			type: { in: ["shell_started", "shell_done"] },
			payload: sessionPayloadFilter(session.id),
			run: { conversationId: session.conversationId },
		},
		// Os mais recentes primeiro (o teto descarta os antigos, nunca os novos); depois volta à ordem cronológica.
		orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
		take: 5000,
		select: { type: true, payload: true, createdAt: true },
	});
	return rows.reverse();
}

/** Dos jobs dados, quais já têm algum `shell_output` gravado (a saída já está no histórico). */
export async function listDevJobIdsWithOutput(session: Pick<DevSessionRecord, "id" | "conversationId">, jobIds: readonly string[]): Promise<Set<string>> {
	const found = new Set<string>();
	if (!session.conversationId) return found;
	for (const jobId of jobIds) {
		const row = await prisma.runEvent.findFirst({
			where: {
				type: "shell_output",
				AND: [{ payload: sessionPayloadFilter(session.id) }, { payload: { path: ["jobId"], equals: jobId } }],
				run: { conversationId: session.conversationId },
			},
			select: { id: true },
		});
		if (row) found.add(jobId);
	}
	return found;
}

/** Run da conversa que recebe eventos emitidos pela API (o mais recente que não é subagente). */
export async function getRunIdForDevEvents(conversationId: string): Promise<string | null> {
	const row = await prisma.agentRun.findFirst({
		where: { conversationId, origin: { not: "subagent" } },
		orderBy: [{ createdAt: "desc" }],
		select: { id: true },
	});
	return row?.id ?? null;
}

const ACTIVE_RUN_STATUSES = ["queued", "running", "retrying", "paused"];

/** Runs principais ainda ativos da conversa (para "Parar": cancelar junto da sessão). */
export async function listActiveMainRunIds(conversationId: string): Promise<string[]> {
	const rows = await prisma.agentRun.findMany({
		where: { conversationId, origin: { not: "subagent" }, status: { in: ACTIVE_RUN_STATUSES } },
		select: { id: true },
	});
	return rows.map((row) => row.id);
}

export type ActiveWorkItem =
	| {
			kind: "dev";
			id: string;
			conversationId: string | null;
			conversationTitle: string | null;
			botId: string | null;
			status: DevSessionStatus;
			repo: string | null;
			branch: string | null;
			startedAt: string;
			lastActiveAt: string;
			awaitingApproval: boolean;
	  }
	| {
			kind: "subagent";
			id: string;
			conversationId: string | null;
			conversationTitle: string | null;
			botId: string | null;
			title: string;
			startedAt: string;
			awaitingApproval: boolean;
	  };

const ACTIVE_DEV_STATUSES: DevSessionStatus[] = ["CREATING", "QUEUED", "RUNNING"];

/**
 * Trabalho em andamento do usuário em todas as conversas: sessões de código
 * ativas (ou paradas há pouco, para o ponto de "não visto") e subagentes
 * rodando. `awaitingApproval` = há cartão de confirmação pendente na conversa.
 */
export async function listActiveWorkForUser(userId: string, options: { recentMs?: number; now?: Date } = {}): Promise<ActiveWorkItem[]> {
	const now = options.now ?? new Date();
	const since = new Date(now.getTime() - (options.recentMs ?? 6 * 60 * 60_000));
	const [sessions, subagents] = await Promise.all([
		prisma.devSession.findMany({
			where: { userId, OR: [{ status: { in: ACTIVE_DEV_STATUSES } }, { status: { in: ["IDLE", "STOPPED", "ERROR"] }, lastActiveAt: { gt: since } }] },
			orderBy: { lastActiveAt: "desc" },
			take: 30,
		}),
		prisma.agentRun.findMany({
			where: { userId, origin: "subagent", status: { in: ["queued", "running", "retrying"] }, createdAt: { gt: since } },
			orderBy: { createdAt: "desc" },
			take: 30,
			select: { id: true, objective: true, createdAt: true, parent: { select: { conversationId: true } }, conversationId: true },
		}),
	]);
	const conversationIds = [
		...new Set([...sessions.map((s) => s.conversationId), ...subagents.map((s) => s.conversationId ?? s.parent?.conversationId ?? null)].filter((id): id is string => !!id)),
	];
	const [titles, pending] = conversationIds.length
		? await Promise.all([
				prisma.conversation.findMany({ where: { id: { in: conversationIds }, userId }, select: { id: true, bot: { select: { id: true, name: true } } } }),
				prisma.conversationMessage.findMany({
					where: { conversationId: { in: conversationIds }, role: "confirm", content: { contains: '"status":"pending"' }, createdAt: { gt: since } },
					select: { conversationId: true },
				}),
			])
		: [[], []];
	const titleOf = new Map(titles.map((row) => [row.id, row.bot?.name ?? null]));
	const botOf = new Map(titles.map((row) => [row.id, row.bot?.id ?? null]));
	const awaiting = new Set(pending.map((row) => row.conversationId));
	const items: ActiveWorkItem[] = [];
	for (const row of sessions) {
		const record = toRecord(row);
		if (!record.conversationId || !titleOf.has(record.conversationId)) continue;
		items.push({
			kind: "dev",
			id: record.id,
			conversationId: record.conversationId,
			conversationTitle: titleOf.get(record.conversationId) ?? null,
			botId: botOf.get(record.conversationId) ?? null,
			status: record.status,
			repo: record.repo,
			branch: record.branch,
			startedAt: record.createdAt.toISOString(),
			lastActiveAt: record.lastActiveAt.toISOString(),
			awaitingApproval: awaiting.has(record.conversationId),
		});
	}
	for (const row of subagents) {
		const conversationId = row.conversationId ?? row.parent?.conversationId ?? null;
		if (!conversationId || !titleOf.has(conversationId)) continue;
		items.push({
			kind: "subagent",
			id: row.id,
			conversationId,
			conversationTitle: titleOf.get(conversationId) ?? null,
			botId: botOf.get(conversationId) ?? null,
			title: row.objective.replace(/\s+/g, " ").trim().slice(0, 80),
			startedAt: row.createdAt.toISOString(),
			awaitingApproval: awaiting.has(conversationId),
		});
	}
	return items;
}
