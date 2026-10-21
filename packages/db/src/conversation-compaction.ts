import { parseConversationCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { getConversationWatermark, type ConversationWatermark } from "./conversations.js";
import { ownerIds } from "./mcp-connections.js";
import { listActiveRunsForConversation, type RunTranscript } from "./runs.js";

/**
 * Parte do banco do `/compact`: o que impede a compactação, a gravação da conversa compactada no checkpoint do
 * run que o próximo turno herda e a marca d'água nova. A conversa levada de um turno para o outro vive no
 * checkpoint do último run de chat; trocá-la por resumo + cauda é regravar `llmMessages` ali.
 */

export type CompactionBlocker = "run_active" | "approval_pending";

/** Roles de cartão que esperam uma decisão da pessoa. */
const PENDING_DECISION_ROLES = ["confirm", "login", "routine-proposal", "bot-proposal"];

/**
 * O que impede de compactar agora: execução em andamento (inclui as que esperam a pessoa) ou aprovação ainda
 * pendente de um run recente (a chamada pendente está na conversa levada e o resumo a esconderia).
 */
export async function findCompactionBlocker(conversationId: string, since?: Date): Promise<CompactionBlocker | null> {
	const active = await listActiveRunsForConversation(conversationId);
	if (active.some((run) => run.status === "waiting_user" || run.status === "waiting_external")) return "approval_pending";
	if (active.length > 0) return "run_active";
	const cards = await prisma.conversationMessage.findMany({
		where: { conversationId, role: { in: PENDING_DECISION_ROLES }, ...(since ? { createdAt: { gte: since } } : {}) },
		orderBy: { createdAt: "desc" },
		take: 30,
		select: { content: true },
	});
	for (const row of cards) {
		const card = parseConversationCard(row.content);
		if (card && "status" in card && card.status === "pending") return "approval_pending";
	}
	return null;
}

export type CompactionWrite = {
	userId: string;
	conversationId: string;
	/** Run cujo checkpoint guarda a conversa levada (o mesmo que `getConversationTranscript` devolveu). */
	transcript: Pick<RunTranscript, "runId" | "updatedAt">;
	llmMessages: unknown[];
	compaction: { before: number; after: number; focus?: string };
	now?: Date;
};

/**
 * Regrava a conversa levada com a versão compactada e avança a marca d'água (tudo o que a compactação leu já está
 * no resumo ou na cauda; o que chegar depois entra como sempre). Otimista: só grava se a linha do run não mudou
 * desde a leitura (`updatedAt`), então duas compactações simultâneas, ou uma compactação e um run que chegou no
 * meio, nunca se sobrepõem. Devolve `false` quando perdeu a corrida.
 */
export async function writeCompactedTranscript(input: CompactionWrite): Promise<boolean> {
	const expected = input.transcript.updatedAt;
	if (!expected) return false;
	const row = await prisma.agentRun.findFirst({
		where: { id: input.transcript.runId, conversationId: input.conversationId, userId: { in: ownerIds(input.userId) } },
		select: { checkpointJson: true, updatedAt: true },
	});
	const raw = row?.checkpointJson;
	if (!row || row.updatedAt.getTime() !== expected.getTime() || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
	const watermark: ConversationWatermark | null = await getConversationWatermark(input.conversationId);
	if (!watermark) return false;
	const checkpoint = {
		...(raw as Record<string, unknown>),
		llmMessages: input.llmMessages,
		transcriptWatermark: watermark,
		compaction: { before: input.compaction.before, after: input.compaction.after, at: (input.now ?? new Date()).toISOString() },
	};
	const written = await prisma.agentRun.updateMany({
		where: { id: input.transcript.runId, updatedAt: row.updatedAt },
		data: { checkpointJson: checkpoint as never },
	});
	return written.count === 1;
}
