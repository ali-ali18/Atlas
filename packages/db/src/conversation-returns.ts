import { SCHEDULE_RETURN_MAX_PENDING } from "@workspace/shared";
import { prisma } from "./client.js";

/**
 * "Volto depois" do motor v3 (`schedule_return`). Todo acesso é escopado pelo dono (`userId` do run ou da sessão):
 * outro usuário não lista, não cancela e não dispara o retorno de ninguém (recurso alheio = não existe).
 */
export type ConversationReturnRecord = {
	id: string;
	userId: string;
	botId: string | null;
	conversationId: string;
	sourceRunId: string;
	dueAt: Date;
	reason: string;
	visible: boolean;
	status: "pending" | "fired" | "cancelled";
	runId: string | null;
	createdAt: Date;
};

type Row = { id: string; userId: string; botId: string | null; conversationId: string; sourceRunId: string; dueAt: Date; reason: string; visible: boolean; status: string; runId: string | null; createdAt: Date };

function toRecord(row: Row): ConversationReturnRecord {
	return { ...row, status: row.status === "fired" || row.status === "cancelled" ? row.status : "pending" };
}

export class ConversationReturnLimitError extends Error {
	constructor() {
		super(`limit of ${SCHEDULE_RETURN_MAX_PENDING} pending returns in this conversation`);
		this.name = "ConversationReturnLimitError";
	}
}

const valid = (userId: string) => Boolean(userId.trim()) && userId !== "default";

/** Pendentes da conversa do dono, do mais próximo ao mais distante. */
export async function listPendingReturns(userId: string, conversationId: string): Promise<ConversationReturnRecord[]> {
	if (!valid(userId)) return [];
	const rows = await prisma.conversationReturn.findMany({ where: { userId, conversationId, status: "pending" }, orderBy: { dueAt: "asc" }, take: 20 });
	return rows.map(toRecord);
}

/**
 * Cria o retorno se a conversa é do dono e ainda cabe (no máximo 3 pendentes). A contagem e a criação andam juntas,
 * sob trava por conversa, para dois agendamentos ao mesmo tempo não passarem do teto.
 */
export async function createConversationReturn(input: {
	userId: string;
	botId?: string | null;
	conversationId: string;
	sourceRunId: string;
	dueAt: Date;
	reason: string;
	visible: boolean;
}): Promise<ConversationReturnRecord> {
	if (!valid(input.userId)) throw new Error("conversa sem dono");
	const owned = await prisma.conversation.findFirst({ where: { id: input.conversationId, userId: input.userId }, select: { id: true } });
	if (!owned) throw new Error("conversa não encontrada");
	const row = await prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`conversation-return:${input.conversationId}`}))`;
		const pending = await tx.conversationReturn.count({ where: { conversationId: input.conversationId, userId: input.userId, status: "pending" } });
		if (pending >= SCHEDULE_RETURN_MAX_PENDING) throw new ConversationReturnLimitError();
		return await tx.conversationReturn.create({
			data: {
				userId: input.userId,
				botId: input.botId ?? null,
				conversationId: input.conversationId,
				sourceRunId: input.sourceRunId,
				dueAt: input.dueAt,
				reason: input.reason.slice(0, 300),
				visible: input.visible,
			},
		});
	});
	return toRecord(row);
}

/** Cancela um retorno pendente do dono. `null` = não existe, é de outro dono ou já disparou/foi cancelado. */
export async function cancelConversationReturn(userId: string, returnId: string, conversationId?: string): Promise<ConversationReturnRecord | null> {
	if (!valid(userId)) return null;
	const where = { id: returnId, userId, status: "pending", ...(conversationId ? { conversationId } : {}) };
	const updated = await prisma.conversationReturn.updateMany({ where, data: { status: "cancelled" } });
	if (updated.count !== 1) return null;
	const row = await prisma.conversationReturn.findFirst({ where: { id: returnId, userId } });
	return row ? toRecord(row) : null;
}

/** O job venceu: reserva o retorno uma vez só (pendente → disparado). `null` = cancelado, já disparado ou de outro dono. */
export async function claimDueReturn(userId: string, returnId: string): Promise<ConversationReturnRecord | null> {
	if (!valid(userId)) return null;
	const updated = await prisma.conversationReturn.updateMany({ where: { id: returnId, userId, status: "pending" }, data: { status: "fired" } });
	if (updated.count !== 1) return null;
	const row = await prisma.conversationReturn.findFirst({ where: { id: returnId, userId } });
	return row ? toRecord(row) : null;
}

/** Criar o run falhou depois da reserva: devolve a "pendente" para a nova tentativa do job disparar. Só sem run gravado. */
export async function releaseReturnClaim(userId: string, returnId: string): Promise<boolean> {
	if (!valid(userId)) return false;
	const updated = await prisma.conversationReturn.updateMany({ where: { id: returnId, userId, status: "fired", runId: null }, data: { status: "pending" } });
	return updated.count === 1;
}

export async function markReturnRun(returnId: string, runId: string): Promise<void> {
	await prisma.conversationReturn.updateMany({ where: { id: returnId }, data: { runId } });
}
