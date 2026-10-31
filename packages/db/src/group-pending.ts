import {
	buildAutoDecisionCard,
	decideGroupPending,
	groupEscalationLabel,
	hasIrreversibleToolName,
	hasOutwardVerb,
	needFromCardRow,
	parseConversationCard,
	type BotNeed,
	type GroupPendingMcp,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { getGroupWithMembers } from "./bot-groups.js";
import { countAutoDecisions, hasAutoDecision, queueAutoDecision } from "./bot-pending.js";
import { getStrictMcpConnection, ownerIds } from "./mcp-connections.js";
import type { SkillPendingPayload } from "./skill-pending.js";

/**
 * Grupos de bots: o bot principal aceita sozinho os pedidos SEGUROS dos membros.
 *
 * Quando um membro (que não é o principal) para num cartão de aprovação na conversa do grupo, a regra pura
 * `decideGroupPending` (shared, sem Jev/LLM) decide aprovar ou escalar. Aprovar grava a nota "Aceito por <principal>"
 * na fila de decisões automáticas (a API aplica pelo mesmo caminho do clique, `answerBotPending`); escalar não faz nada
 * e o cartão segue esperando o usuário. Tudo escopado pelo dono da intenção pendente: grupo, membros, conexão e run.
 */

const SCAN_INTENTS = 100;
const SCAN_CARDS = 20;
/** Cartões já avaliados e escalados neste processo (a regra é pura: não precisa reavaliar a cada varredura). */
const ESCALATED_MAX = 500;
const escalated = new Set<string>();

function rememberEscalated(cardId: string): void {
	if (escalated.size >= ESCALATED_MAX) escalated.clear();
	escalated.add(cardId);
}

export type GroupPendingSweepResult = { scanned: number; approved: number; escalated: number };

type Intent = { userId: string; conversationId: string; payload: SkillPendingPayload };

/** O membro `botId` pediu o cartão `confirmId` na conversa do grupo? Devolve a linha do cartão ainda pendente. */
async function findPendingCardRow(conversationId: string, confirmId: string) {
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "confirm" },
		orderBy: { createdAt: "desc" },
		take: SCAN_CARDS,
	});
	return (
		rows.find((row: { content: string }) => {
			const card = parseConversationCard(row.content);
			return card?.kind === "confirm" && card.confirmId === confirmId && card.status === "pending";
		}) ?? null
	);
}

/** Fatos do conector (do dono da conversa) para a regra pura. */
async function mcpFacts(intent: Intent): Promise<GroupPendingMcp | undefined> {
	const call = intent.payload.mcpCall;
	if (!call) return undefined;
	const connection = await getStrictMcpConnection(call.connectionId, intent.userId).catch(() => null);
	// Marcada só leitura pelo dono (e sem verbo que atinge terceiros ou sem volta): conta como leitura.
	const markedRead = connection?.toolMarks?.[call.toolName] === "read" && !hasIrreversibleToolName(call.toolName) && !hasOutwardVerb(call.toolName);
	return {
		toolName: call.toolName,
		...(markedRead ? { actionClass: "read" as const } : call.actionClass ? { actionClass: call.actionClass } : {}),
		args: call.args ?? {},
		confirmWrites: connection ? connection.confirmWrites : null,
		...(call.jevReview ? { jevReview: true } : {}),
		...(call.untrustedSeen ? { untrustedSeen: true } : {}),
	};
}

function subjectOf(need: BotNeed): string {
	const item = need.item;
	const text = item && (item.kind === "command" || item.kind === "write") ? (item.preview ?? item.title) : (need.confirmTitle ?? need.label);
	return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

async function evaluate(intent: Intent, group: { id: string; conversationId: string }): Promise<"approved" | "escalated" | "skipped"> {
	const confirmId = intent.payload.confirmId;
	const requesterId = intent.payload.botId;
	if (!confirmId || !requesterId) return "skipped";
	const found = await getGroupWithMembers(intent.userId, group.id);
	if (!found) return "skipped";
	const requester = found.members.find((member) => member.id === requesterId);
	const primary = found.members.find((member) => member.isPrimary);
	// Sem principal, ou o principal é quem pede (não se autoaprova): comportamento de sempre.
	if (!requester || !primary || primary.id === requester.id) return "skipped";
	const row = await findPendingCardRow(group.conversationId, confirmId);
	if (!row || escalated.has(row.id)) return "skipped";
	if (await hasAutoDecision(group.conversationId, row.id)) return "skipped";

	// O cartão tem de ser de um run do próprio membro, do mesmo dono, para a origem valer.
	const run = row.runId ? await prisma.agentRun.findUnique({ where: { id: row.runId }, select: { userId: true, botId: true, origin: true } }) : null;
	const sameRun = run && ownerIds(intent.userId).includes(run.userId) && run.botId === requester.id;
	const need = needFromCardRow({
		rowId: row.id,
		conversationId: group.conversationId,
		role: row.role,
		content: row.content,
		intent: { action: intent.payload.action, confirmId, actionClass: intent.payload.mcpCall?.actionClass },
	});
	if (!need) return "skipped";

	const reply = await prisma.groupReply.findFirst({ where: { conversationId: group.conversationId, botId: requester.id }, orderBy: { createdAt: "desc" }, select: { turnId: true } });
	const botMessageId = reply?.turnId ?? `group:${group.id}`;
	const decision = decideGroupPending({
		need,
		item: need.item,
		origin: sameRun ? run.origin : undefined,
		requesterIsPrimary: false,
		autoCount: await countAutoDecisions(group.conversationId, botMessageId),
		mcp: await mcpFacts(intent),
	});
	if (decision.action === "escalate") {
		rememberEscalated(row.id);
		console.log(`[group-pending] escalate group=${group.id} card=${row.id} why=${decision.why} (${groupEscalationLabel(decision.why)})`);
		return "escalated";
	}
	const card = buildAutoDecisionCard({
		botMessageId,
		botId: requester.id,
		botName: requester.name,
		deciderName: primary.name,
		decision: "approved",
		subject: subjectOf(need),
		reason: decision.why,
		withJev: false,
		need,
		viaGroup: true,
	});
	const queued = await queueAutoDecision(group.conversationId, card);
	if (queued) console.log(`[group-pending] approve group=${group.id} card=${row.id} why=${decision.why}`);
	return queued ? "approved" : "skipped";
}

/**
 * Varre as aprovações pendentes das conversas de grupo e deixa o bot principal aceitar as seguras.
 * Idempotente (uma nota por cartão) e seguro com vários workers: quem perde a corrida não repete.
 */
export async function autoDecideGroupPending(now: Date = new Date()): Promise<GroupPendingSweepResult> {
	const result: GroupPendingSweepResult = { scanned: 0, approved: 0, escalated: 0 };
	const intents = await prisma.skillPendingIntent.findMany({
		where: { kind: "confirm", expiresAt: { gt: now } },
		orderBy: { expiresAt: "desc" },
		take: SCAN_INTENTS,
	});
	if (intents.length === 0) return result;
	const groups = await prisma.bot.findMany({
		where: { conversationId: { in: intents.map((intent: { conversationId: string }) => intent.conversationId) }, memberIds: { isEmpty: false } },
		select: { id: true, ownerId: true, conversationId: true },
	});
	for (const row of intents) {
		const raw: unknown = row.payload;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const intent: Intent = { userId: row.userId, conversationId: row.conversationId, payload: raw as SkillPendingPayload };
		// A conversa tem de ser de um grupo DO MESMO dono da intenção.
		const group = groups.find((row: { conversationId: string | null; ownerId: string | null }) => row.conversationId === intent.conversationId && row.ownerId === intent.userId);
		if (!group?.conversationId) continue;
		result.scanned += 1;
		try {
			const outcome = await evaluate(intent, { id: group.id, conversationId: group.conversationId });
			if (outcome === "approved") result.approved += 1;
			if (outcome === "escalated") result.escalated += 1;
		} catch (error) {
			console.error(`[group-pending] evaluate failed group=${group.id}`, error instanceof Error ? error.name : "error");
		}
	}
	return result;
}
