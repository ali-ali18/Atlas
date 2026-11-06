/**
 * Sono do bot no banco (Motor v4, F5.3): reserva do trabalho, relatórios e a leitura do dia. Toda função filtra pelo
 * `userId` (o dono do relatório e do bot); relatório de outro dono é `null`, a rota responde 404.
 */
import { Prisma } from "@prisma/client";
import {
	readStoredProposals,
	type OwnerNoteView,
	type SleepMessage,
	type SleepReportKind,
	type SleepReportStatus,
	type SleepReportView,
	type SleepRunRecord,
	type SleepStoredProposal,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { toOwnerNote } from "./notes.js";

/** Um sono `running` há mais que isto é considerado abandonado (worker caiu) e pode ser reassumido. */
export const SLEEP_STALE_MS = 30 * 60 * 1000;
export const SLEEP_REPORTS_PAGE_SIZE = 20;
export const SLEEP_REPORTS_MAX_PAGE_SIZE = 50;

type ReportRow = { id: string; botId: string; kind: string; slot: string; status: string; summary: string | null; proposalsJson: unknown; statsJson: unknown; createdAt: Date; finishedAt: Date | null };

const numbersOf = (raw: unknown): Record<string, number> => {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
};

export function toSleepReport(row: ReportRow): SleepReportView {
	return {
		id: row.id,
		botId: row.botId,
		kind: row.kind as SleepReportKind,
		slot: row.slot,
		status: row.status as SleepReportStatus,
		summary: row.summary,
		proposals: readStoredProposals(row.proposalsJson),
		stats: numbersOf(row.statsJson),
		createdAt: row.createdAt.toISOString(),
		finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
	};
}

/**
 * Reserva o sono deste bot neste slot. A unicidade `(botId, kind, slot)` é a trava: o segundo worker perde. Um `running`
 * abandonado (mais velho que `SLEEP_STALE_MS`) é reassumido. `null` = outro já fez ou está fazendo.
 */
export async function claimSleepSlot(input: { userId: string; botId: string; kind: SleepReportKind; slot: string; now: Date }): Promise<{ id: string } | null> {
	try {
		const row = await prisma.sleepReport.create({ data: { userId: input.userId, botId: input.botId, kind: input.kind, slot: input.slot, status: "running", createdAt: input.now }, select: { id: true } });
		return row;
	} catch (error) {
		if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
	}
	const cutoff = new Date(input.now.getTime() - SLEEP_STALE_MS);
	const taken = await prisma.sleepReport.updateMany({ where: { userId: input.userId, botId: input.botId, kind: input.kind, slot: input.slot, status: "running", createdAt: { lt: cutoff } }, data: { createdAt: input.now } });
	if (taken.count === 0) return null;
	const row = await prisma.sleepReport.findFirst({ where: { userId: input.userId, botId: input.botId, kind: input.kind, slot: input.slot }, select: { id: true } });
	return row;
}

export async function finishSleepReport(input: { userId: string; id: string; status: Exclude<SleepReportStatus, "running">; detail?: string; summary?: string; proposals?: readonly SleepStoredProposal[]; stats?: Record<string, number>; windowEnd?: Date; now?: Date }): Promise<void> {
	await prisma.sleepReport.updateMany({
		where: { id: input.id, userId: input.userId },
		data: {
			status: input.status,
			detail: input.detail ?? null,
			summary: input.summary ?? null,
			proposalsJson: (input.proposals ?? []) as unknown as Prisma.InputJsonValue,
			statsJson: (input.stats ?? {}) as Prisma.InputJsonValue,
			...(input.windowEnd && { windowEnd: input.windowEnd }),
			finishedAt: input.now ?? new Date(),
		},
	});
}

/** Fim da janela do último sono do bot que leu o dia (feito ou dia quieto): o começo do próximo. `null` = nunca dormiu. */
export async function getPreviousSleepEnd(userId: string, botId: string): Promise<Date | null> {
	const row = await prisma.sleepReport.findFirst({ where: { userId, botId, kind: "daily", status: { in: ["done", "skipped"] }, windowEnd: { not: null } }, orderBy: { windowEnd: "desc" }, select: { windowEnd: true } });
	return row?.windowEnd ?? null;
}

export async function listSleepReports(input: { userId: string; botId?: string; kind?: SleepReportKind; cursor?: string; limit?: number }): Promise<{ reports: SleepReportView[]; nextCursor: string | null }> {
	const take = Math.min(Math.max(input.limit ?? SLEEP_REPORTS_PAGE_SIZE, 1), SLEEP_REPORTS_MAX_PAGE_SIZE);
	const rows = await prisma.sleepReport.findMany({
		where: { userId: input.userId, status: { in: ["done", "failed"] }, ...(input.botId && { botId: input.botId }), ...(input.kind && { kind: input.kind }) },
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: take + 1,
		...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
	});
	const page = rows.slice(0, take);
	return { reports: page.map(toSleepReport), nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null };
}

export async function getSleepReport(userId: string, id: string): Promise<SleepReportView | null> {
	const row = await prisma.sleepReport.findFirst({ where: { id, userId } });
	return row ? toSleepReport(row) : null;
}

/** O dono dispensa uma proposta (habilidade, caso de eval, achado do doctor). `null` = relatório ou proposta inexistente. */
export async function dismissSleepProposal(input: { userId: string; reportId: string; proposalId: string }): Promise<SleepReportView | null> {
	return prisma.$transaction(async (tx) => {
		const row = await tx.sleepReport.findFirst({ where: { id: input.reportId, userId: input.userId } });
		if (!row) return null;
		const proposals = readStoredProposals(row.proposalsJson);
		if (!proposals.some((proposal) => proposal.id === input.proposalId)) return null;
		const next = proposals.map((proposal) => (proposal.id === input.proposalId ? { ...proposal, status: "dismissed" as const } : proposal));
		const updated = await tx.sleepReport.update({ where: { id: row.id }, data: { proposalsJson: next as unknown as Prisma.InputJsonValue } });
		return toSleepReport(updated);
	});
}

// ---------------------------------------------------------------------------
// A leitura do dia
// ---------------------------------------------------------------------------

export type SleepBotRef = { id: string; ownerId: string; name: string; language: string; conversationId: string | null; policyJson: unknown };

/** Bots dos donos dados que têm conversa direta. Quem filtra a conta (flag do v4) é o worker; aqui só se lê. */
export async function listBotsForSleep(ownerIds: readonly string[]): Promise<SleepBotRef[]> {
	if (ownerIds.length === 0) return [];
	const rows = await prisma.bot.findMany({ where: { ownerId: { in: [...ownerIds] }, conversationId: { not: null } }, select: { id: true, ownerId: true, name: true, language: true, conversationId: true, policyJson: true }, orderBy: { id: "asc" } });
	return rows.flatMap((row) => (row.ownerId ? [{ id: row.id, ownerId: row.ownerId, name: row.name, language: row.language, conversationId: row.conversationId, policyJson: row.policyJson }] : []));
}

export type SleepDayInput = {
	messages: SleepMessage[];
	runs: SleepRunRecord[];
	notes: OwnerNoteView[];
};

/**
 * O que o sono lê de um bot: as mensagens da CONVERSA DIRETA do bot com o dono na janela, os runs v4 de chat dela (com
 * o journal) e as notas visíveis ao bot. Conversa de grupo não entra: o escopo é a conversa do bot (`Bot.conversationId`),
 * conferida contra o dono em duas pontas (bot e conversa).
 */
export async function loadSleepDay(input: { userId: string; botId: string; from: Date; to: Date }): Promise<SleepDayInput | null> {
	const bot = await prisma.bot.findFirst({ where: { id: input.botId, ownerId: input.userId }, select: { conversationId: true } });
	if (!bot?.conversationId) return null;
	const conversation = await prisma.conversation.findFirst({ where: { id: bot.conversationId, userId: input.userId }, select: { id: true } });
	if (!conversation) return null;
	const range = { gte: input.from, lt: input.to };
	const [messages, runs, notes] = await Promise.all([
		prisma.conversationMessage.findMany({ where: { conversationId: conversation.id, createdAt: range }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, role: true, content: true, origin: true }, take: 20_000 }),
		prisma.agentRun.findMany({
			where: { userId: input.userId, botId: input.botId, conversationId: conversation.id, origin: "chat", createdAt: range, v4Journal: { some: {} } },
			orderBy: { createdAt: "asc" },
			take: 500,
			select: { id: true, origin: true, status: true, stopReason: true, objective: true, v4Journal: { select: { step: true, toolName: true, state: true }, orderBy: [{ step: "asc" }, { createdAt: "asc" }] } },
		}),
		prisma.note.findMany({ where: { userId: input.userId, OR: [{ botId: null }, { botId: input.botId }] }, orderBy: { updatedAt: "desc" }, take: 500 }),
	]);
	return {
		messages,
		runs: runs.map((run) => ({ runId: run.id, origin: run.origin, status: run.status, stopReason: run.stopReason, objective: run.objective, journal: run.v4Journal.map((entry) => ({ step: entry.step, toolName: entry.toolName, outcome: entry.state })) })),
		notes: notes.map(toOwnerNote),
	};
}

/** Itens de memória do dono para o doctor (perfil e camada do bot), com o que o dono já vê na tela. */
export async function listMemoryForDoctor(input: { userId: string; botId: string }): Promise<Array<{ id: string; scope: string; content: string; updatedAt: Date; validUntil: Date | null }>> {
	const rows = await prisma.memoryEntry.findMany({
		where: { userId: input.userId, OR: [{ target: "user" }, { target: "memory", botId: input.botId }] },
		select: { id: true, target: true, content: true, updatedAt: true, validUntil: true },
		orderBy: { id: "asc" },
	});
	return rows.map((row) => ({ id: row.id, scope: row.target === "user" ? "owner" : "bot", content: row.content, updatedAt: row.updatedAt, validUntil: row.validUntil }));
}
