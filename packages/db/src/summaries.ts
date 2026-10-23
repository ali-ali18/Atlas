import type { ConversationSummary } from "@workspace/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

export type SummaryFactsInput = {
	decisions?: string[];
	pendings?: string[];
	prefs?: string[];
	constraints?: string[];
};

export type IdleConversation = {
	conversationId: string;
	botId: string | null;
	lastMessageId: string;
	lastMessageAt: Date;
	messageCount: number;
	snapshotVersion: string | null;
	summaryVersion: number | null;
};

type IdleRow = {
	conversationId: string;
	botId: string | null;
	lastMessageId: string;
	lastMessageAt: Date;
	messageCount: bigint;
	snapshotVersion: string | null;
	summaryVersion: number | null;
};

function toConversationSummary(row: {
	id: string;
	conversationId: string;
	rangeStart: Date | null;
	rangeEnd: Date | null;
	version: number;
	content: string;
	factsJson: unknown;
	snapshotVersion: string | null;
	createdAt: Date;
}): ConversationSummary {
	return {
		id: row.id,
		conversationId: row.conversationId,
		rangeStart: row.rangeStart ? row.rangeStart.toISOString() : null,
		rangeEnd: row.rangeEnd ? row.rangeEnd.toISOString() : null,
		version: row.version,
		content: row.content,
		factsJson: (row.factsJson as ConversationSummary["factsJson"]) ?? null,
		snapshotVersion: row.snapshotVersion,
		createdAt: row.createdAt.toISOString(),
	};
}

/** Resumo mais recente da conversa, ou null. */
export async function getLatestSummary(
	conversationId: string,
): Promise<ConversationSummary | null> {
	const row = await prisma.conversationSummary.findFirst({
		where: { conversationId },
		orderBy: { version: "desc" },
	});
	return row ? toConversationSummary(row) : null;
}

/**
 * Papéis ignorados na decisão de frescor: sistema + cards da timeline (não
 * vão para o LLM nem disparam run). O resumo precisa cobrir o histórico
 * relevante, não esses papéis.
 */
export const FRESH_SUMMARY_IGNORE_ROLES: readonly string[] = [
	"system",
	"skill",
	"confirm",
	"login",
	"file",
	"routine",
	"questionnaire",
	"bot-profile",
	"bot-link",
	"tool-budget",
	"provider-fallback",
	"subagents",
	"code-run",
	"chart",
	"page",
	"task-list",
	"compaction",
	"revised-draft",
];

export type FreshSummaryOptions = {
	/** Papéis a ignorar (default: system + cards). */
	ignoreRoles?: string[];
};

/** Entrada mínima (ordem desc: a que disparou o run primeiro). */
export type FreshCandidateMessage = {
	id: string;
	createdAt: string | Date;
};

/**
 * Decisão pura de frescor: o resumo cobre tudo ANTES da mensagem que disparou
 * o run (a última user/assistant — `recentDesc[0]`)? Exige snapshotVersion ==
 * id da penúltima OU rangeEnd cobrindo até ela. Sem penúltima (primeira msg),
 * o latest existente vale. Puro e testável (o acesso ao banco fica no
 * `getFreshSummary`).
 */
export function isSummaryFreshSnapshot(
	latest: {
		snapshotVersion?: string | null;
		rangeEnd?: string | null;
	} | null,
	recentDesc: readonly FreshCandidateMessage[],
): boolean {
	if (!latest) return false;
	if (recentDesc.length <= 1) return true;
	const penultimate = recentDesc[1];
	if (!penultimate) return true;
	if (latest.snapshotVersion && latest.snapshotVersion === penultimate.id) {
		return true;
	}
	if (latest.rangeEnd) {
		const rangeEndTime = Date.parse(latest.rangeEnd);
		const penTime = Date.parse(
			penultimate.createdAt instanceof Date
				? penultimate.createdAt.toISOString()
				: String(penultimate.createdAt),
		);
		if (
			!Number.isNaN(rangeEndTime) &&
			!Number.isNaN(penTime) &&
			rangeEndTime >= penTime
		) {
			return true;
		}
	}
	return false;
}

/**
 * Resumo fresco: cobre tudo antes da mensagem que disparou o run, ignorando
 * cards/sistema. A mensagem nova (última user/assistant) NÃO precisa estar
 * coberta — ela é o gatilho do run atual, e exigir isso invalidava todo
 * resumo a cada mensagem nova. Sem frescor não há ciclo limpo — caller cai
 * no caminho completo. Usado pelo worker na decisão do modo por run.
 */
export async function getFreshSummary(
	conversationId: string,
	options: FreshSummaryOptions = {},
): Promise<ConversationSummary | null> {
	const latest = await getLatestSummary(conversationId);
	if (!latest) return null;
	const ignore = options.ignoreRoles ?? [...FRESH_SUMMARY_IGNORE_ROLES];
	const recent = await prisma.conversationMessage.findMany({
		where: {
			conversationId,
			role: { notIn: ignore },
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: 5,
		select: { id: true, createdAt: true },
	});
	if (!isSummaryFreshSnapshot(latest, recent)) return null;
	return latest;
}

/**
 * Grava nova versão do resumo (version = max+1). Transcript intacto —
 * resumo é só continuidade operacional para reinjeção no prompt.
 */
export async function writeConversationSummary(input: {
	conversationId: string;
	content: string;
	facts?: SummaryFactsInput;
	rangeStart?: Date | null;
	rangeEnd?: Date | null;
	snapshotVersion?: string | null;
}): Promise<ConversationSummary> {
	const latest = await getLatestSummary(input.conversationId);
	const row = await prisma.conversationSummary.create({
		data: {
			conversationId: input.conversationId,
			version: (latest?.version ?? 0) + 1,
			content: input.content,
			factsJson:
				input.facts === undefined
					? undefined
					: (JSON.parse(JSON.stringify(input.facts)) as Prisma.InputJsonValue),
			rangeStart: input.rangeStart ?? null,
			rangeEnd: input.rangeEnd ?? null,
			snapshotVersion: input.snapshotVersion ?? null,
		},
	});
	return toConversationSummary(row);
}

/**
 * Conversas ociosas precisando de resumo: última msg mais velha que o idle,
 * com ao menos `minMessages`, sem run ativo e sem resumo cobrindo a última
 * msg (snapshotVersion = id da última msg = fresco, pula).
 */
export async function findConversationsNeedingSummary(
	idleMs: number,
	minMessages = 20,
	limit = 20,
): Promise<IdleConversation[]> {
	const rows = (await prisma.$queryRawUnsafe(
		`
		SELECT m."conversationId" AS "conversationId",
		       b."id" AS "botId",
		       m."id" AS "lastMessageId",
		       m."createdAt" AS "lastMessageAt",
		       c."count" AS "messageCount",
		       s."snapshotVersion" AS "snapshotVersion",
		       s."version" AS "summaryVersion"
		FROM (
			SELECT DISTINCT ON ("conversationId") "conversationId", id, "createdAt"
			FROM conversation_messages
			ORDER BY "conversationId", "createdAt" DESC, id DESC
		) m
		JOIN (
			SELECT "conversationId", COUNT(*) AS count
			FROM conversation_messages
			GROUP BY "conversationId"
		) c ON c."conversationId" = m."conversationId"
		LEFT JOIN bots b ON b."conversationId" = m."conversationId"
		LEFT JOIN LATERAL (
			SELECT "snapshotVersion", "version"
			FROM conversation_summaries
			WHERE "conversationId" = m."conversationId"
			ORDER BY "version" DESC
			LIMIT 1
		) s ON true
		WHERE m."createdAt" < NOW() - ($1 * INTERVAL '1 millisecond')
		  AND c."count" >= $2
		  AND (s."snapshotVersion" IS NULL OR s."snapshotVersion" <> m."id")
		  AND NOT EXISTS (
			SELECT 1 FROM agent_runs r
			WHERE r."conversationId" = m."conversationId"
			  AND r.status IN ('queued','running','retrying','paused','waiting_user','waiting_external')
		  )
		ORDER BY m."createdAt" ASC
		LIMIT $3
		`,
		idleMs,
		minMessages,
		limit,
	)) as IdleRow[];
	return rows.map((row) => ({
		conversationId: row.conversationId,
		botId: row.botId,
		lastMessageId: row.lastMessageId,
		lastMessageAt: row.lastMessageAt,
		messageCount: Number(row.messageCount),
		snapshotVersion: row.snapshotVersion,
		summaryVersion: row.summaryVersion,
	}));
}

/** Bloco system do resumo para reinjeção no prompt (cap ~2000 chars). */
export function renderSummaryBlock(summary: {
	content: string;
	rangeEnd: string | null;
	version: number;
	factsJson?: unknown;
}): string {
	const lines = [`════ RESUMO DA CONVERSA (versão ${summary.version}) ════`];
	if (summary.rangeEnd) {
		lines.push(`(cobre até ${summary.rangeEnd})`);
	}
	lines.push(summary.content.slice(0, 2000));
	const facts = summary.factsJson as
		| {
				decisions?: string[];
				pendings?: string[];
				prefs?: string[];
				constraints?: string[];
		  }
		| null
		| undefined;
	if (facts) {
		const section = (label: string, items?: string[]) => {
			if (!items || items.length === 0) return;
			lines.push(`${label}: ${items.slice(0, 10).join(" | ")}`);
		};
		section("Decisões", facts.decisions);
		section("Pendências", facts.pendings);
		section("Preferências", facts.prefs);
		section("Regras", facts.constraints);
	}
	return lines.join("\n");
}
