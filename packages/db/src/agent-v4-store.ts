/**
 * Store do motor v4 (F1.12): journal de efeitos, recibos, notas, ofertas por conversa e checkpoint por passo.
 * Tabelas NOVAS (migration aditiva `agent_v4_store`); o checkpoint vai em `AgentRun.checkpointJson` sob a chave `v4`,
 * por merge de jsonb, sem tocar nas chaves que o v1/v2 gravam.
 *
 * Toda função recebe o `userId` do RUN (nunca do modelo) e filtra por ele (`ownerIds`): dono vazio ou `"default"` não
 * lê nem escreve nada, e o recurso de outro dono é "não encontrado". Os tipos são estruturais (iguais aos das portas
 * de `@workspace/agent`) para o db não depender do motor.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { ResourceOwnershipError } from "./conversations.js";
import { ownerIds } from "./mcp-connections.js";
import type { RunLease } from "./runs.js";

export const AGENT_NOTE_TITLE_MAX = 500;
export const AGENT_NOTE_BODY_MAX = 4_000_000;
export const AGENT_OFFERS_MAX = 50;
export const AGENT_DECLINED_MAX = 200;
const LABEL_MAX = 500;
const TEXT_MAX = 4_000;

const owned = (userId: string): boolean => ownerIds(userId).length > 0;

/** Falha de chave estrangeira / registro ausente (o run não é do dono) vira "não encontrado". */
function asOwnership(error: unknown): never {
	if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2025" || error.code === "P2003")) throw new ResourceOwnershipError();
	throw error;
}

function requireOwner(userId: string): void {
	if (!owned(userId)) throw new ResourceOwnershipError();
}

function checkText(name: string, value: string, max: number): string {
	if (typeof value !== "string" || value.length > max) throw new RangeError(`${name} inválido ou maior que ${max} caracteres`);
	return value;
}

// ---------------------------------------------------------------- checkpoint

export type AgentV4Checkpoint = { runId: string; userId: string; step: number; state: string; payload: unknown };

/**
 * Grava o checkpoint do v4 em `checkpointJson.v4` (merge jsonb atômico; as outras chaves ficam). Só no run do dono; com
 * `lease`, só enquanto o lease é o desta execução (mesma cerca do `saveAgentRunCheckpoint`): perdeu → `lease_lost`.
 */
export async function saveAgentV4Checkpoint(userId: string, checkpoint: AgentV4Checkpoint, lease?: Pick<RunLease, "owner" | "token"> | null): Promise<void> {
	requireOwner(userId);
	const patch = JSON.stringify({ v4: { step: checkpoint.step, state: checkpoint.state, payload: checkpoint.payload } });
	const updated = lease
		? await prisma.$executeRaw`
			UPDATE "agent_runs"
			SET "checkpointJson" = COALESCE("checkpointJson", '{}'::jsonb) || ${patch}::jsonb
			WHERE "id" = ${checkpoint.runId} AND "userId" = ${userId}
				AND "leaseOwner" = ${lease.owner} AND "leaseToken" = ${lease.token} AND "leaseUntil" > now()`
		: await prisma.$executeRaw`
			UPDATE "agent_runs"
			SET "checkpointJson" = COALESCE("checkpointJson", '{}'::jsonb) || ${patch}::jsonb
			WHERE "id" = ${checkpoint.runId} AND "userId" = ${userId}`;
	if (updated === 0) {
		if (lease) throw new Error("lease_lost");
		throw new ResourceOwnershipError();
	}
}

export async function loadAgentV4Checkpoint(userId: string, runId: string): Promise<AgentV4Checkpoint | null> {
	if (!owned(userId)) return null;
	const rows = await prisma.$queryRaw<Array<{ v4: { step: number; state: string; payload: unknown } | null }>>`
		SELECT "checkpointJson"->'v4' AS "v4" FROM "agent_runs" WHERE "id" = ${runId} AND "userId" = ${userId}`;
	const v4 = rows[0]?.v4;
	return v4 && typeof v4 === "object" ? { runId, userId, step: v4.step, state: v4.state, payload: v4.payload } : null;
}

// ------------------------------------------------------------------- journal

export type AgentJournalRecord = {
	runId: string;
	userId: string;
	step: number;
	idempotencyKey: string;
	toolName: string;
	argsHash: string;
	outcome: "started" | "succeeded" | "failed";
};

const OUTCOMES: ReadonlySet<string> = new Set(["started", "succeeded", "failed"]);

type JournalRow = { runId: string; userId: string; step: number; idempotencyKey: string; toolName: string; argsHash: string; state: string };
const toJournal = (row: JournalRow): AgentJournalRecord => ({ runId: row.runId, userId: row.userId, step: row.step, idempotencyKey: row.idempotencyKey, toolName: row.toolName, argsHash: row.argsHash, outcome: row.state as AgentJournalRecord["outcome"] });

/**
 * Grava a entrada do journal (upsert pela chave de idempotência, por dono e run). `started` nunca rebaixa um estado que
 * já terminou. O run precisa ser do dono (senão "não encontrado").
 */
export async function appendAgentJournalEntry(entry: AgentJournalRecord): Promise<void> {
	requireOwner(entry.userId);
	if (!OUTCOMES.has(entry.outcome)) throw new RangeError("outcome inválido");
	checkText("idempotencyKey", entry.idempotencyKey, LABEL_MAX);
	const data = { step: entry.step, toolName: checkText("toolName", entry.toolName, LABEL_MAX), argsHash: checkText("argsHash", entry.argsHash, LABEL_MAX), state: entry.outcome };
	try {
		await prisma.agentJournalEntry.upsert({
			where: { userId_runId_idempotencyKey: { userId: entry.userId, runId: entry.runId, idempotencyKey: entry.idempotencyKey } },
			create: { ...data, idempotencyKey: entry.idempotencyKey, userId: entry.userId, run: { connect: { id: entry.runId, userId: entry.userId } } },
			update: entry.outcome === "started" ? {} : { state: entry.outcome, step: entry.step },
		});
	} catch (error) {
		asOwnership(error);
	}
}

export async function findAgentJournalEntry(userId: string, runId: string, idempotencyKey: string): Promise<AgentJournalRecord | null> {
	if (!owned(userId)) return null;
	const row = await prisma.agentJournalEntry.findFirst({ where: { userId, runId, idempotencyKey } });
	return row ? toJournal(row) : null;
}

export async function listAgentJournalEntries(userId: string, runId: string): Promise<AgentJournalRecord[]> {
	if (!owned(userId)) return [];
	const rows = await prisma.agentJournalEntry.findMany({ where: { userId, runId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 2000 });
	return rows.map(toJournal);
}

// ------------------------------------------------------------------- recibos

export type AgentReceiptRecord = { runId: string; userId: string; toolName: string; effect: string; summary: string; where?: string; externalId?: string; url?: string; at: Date };

export async function appendAgentReceipt(receipt: AgentReceiptRecord): Promise<void> {
	requireOwner(receipt.userId);
	try {
		await prisma.agentReceipt.create({
			data: {
				userId: receipt.userId,
				run: { connect: { id: receipt.runId, userId: receipt.userId } },
				toolName: checkText("toolName", receipt.toolName, LABEL_MAX),
				effect: checkText("effect", receipt.effect, LABEL_MAX),
				summary: checkText("summary", receipt.summary, TEXT_MAX),
				location: receipt.where === undefined ? null : checkText("where", receipt.where, TEXT_MAX),
				externalId: receipt.externalId === undefined ? null : checkText("externalId", receipt.externalId, LABEL_MAX),
				url: receipt.url === undefined ? null : checkText("url", receipt.url, 2_000),
				createdAt: receipt.at,
			},
		});
	} catch (error) {
		asOwnership(error);
	}
}

export async function listAgentReceipts(userId: string, runId: string): Promise<AgentReceiptRecord[]> {
	if (!owned(userId)) return [];
	const rows = await prisma.agentReceipt.findMany({ where: { userId, runId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 500 });
	return rows.map((row) => ({
		runId: row.runId,
		userId: row.userId,
		toolName: row.toolName,
		effect: row.effect,
		summary: row.summary,
		...(row.location !== null && { where: row.location }),
		...(row.externalId !== null && { externalId: row.externalId }),
		...(row.url !== null && { url: row.url }),
		at: row.createdAt,
	}));
}

// --------------------------------------------------------------------- notas

export type AgentNoteRecord = { id: string; userId: string; title: string; body: string; pinned: boolean; botId?: string | null; sourceRunId?: string | null };

type NoteRow = { id: string; userId: string; title: string; body: string; pinned: boolean; botId: string | null; sourceRunId: string | null };
const toNote = (row: NoteRow): AgentNoteRecord => ({ id: row.id, userId: row.userId, title: row.title, body: row.body, pinned: row.pinned, botId: row.botId, sourceRunId: row.sourceRunId });

/** Cria ou atualiza a nota do dono (chave `(userId, id)`: o mesmo id de outro dono nunca é tocado). */
export async function saveAgentNote(note: AgentNoteRecord): Promise<void> {
	requireOwner(note.userId);
	checkText("id", note.id, LABEL_MAX);
	const data = {
		title: checkText("title", note.title, AGENT_NOTE_TITLE_MAX),
		body: checkText("body", note.body, AGENT_NOTE_BODY_MAX),
		pinned: note.pinned,
		botId: note.botId ?? null,
		sourceRunId: note.sourceRunId ?? null,
	};
	await prisma.agentNote.upsert({ where: { userId_id: { userId: note.userId, id: note.id } }, create: { ...data, id: note.id, userId: note.userId }, update: data });
}

export async function getAgentNote(userId: string, id: string): Promise<AgentNoteRecord | null> {
	if (!owned(userId)) return null;
	const row = await prisma.agentNote.findFirst({ where: { userId, id } });
	return row ? toNote(row) : null;
}

export async function listAgentNotes(userId: string, limit = 200): Promise<AgentNoteRecord[]> {
	if (!owned(userId)) return [];
	const rows = await prisma.agentNote.findMany({ where: { userId }, orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }, { id: "asc" }], take: Math.min(Math.max(1, Math.floor(limit)), 500) });
	return rows.map(toNote);
}

export async function removeAgentNote(userId: string, id: string): Promise<boolean> {
	if (!owned(userId)) return false;
	const { count } = await prisma.agentNote.deleteMany({ where: { userId, id } });
	return count > 0;
}

// -------------------------------------------------------- ofertas da conversa

export type AgentOfferRecord = { cardId: string; label: string; state: "open" | "answered" | "dismissed" | "ignored" };
export type AgentConversationStateRecord = { offers: AgentOfferRecord[]; declinedOffers: string[] };

const OFFER_STATES: ReadonlySet<string> = new Set(["open", "answered", "dismissed", "ignored"]);

export async function getAgentConversationState(userId: string, conversationId: string): Promise<AgentConversationStateRecord> {
	if (!owned(userId)) return { offers: [], declinedOffers: [] };
	const [offers, declined] = await Promise.all([
		prisma.agentConversationOffer.findMany({ where: { userId, conversationId }, orderBy: [{ position: "asc" }, { id: "asc" }], take: AGENT_OFFERS_MAX }),
		prisma.agentConversationDeclined.findMany({ where: { userId, conversationId }, orderBy: [{ createdAt: "asc" }, { label: "asc" }], take: AGENT_DECLINED_MAX }),
	]);
	return {
		offers: offers.map((o) => ({ cardId: o.cardId, label: o.label, state: o.state as AgentOfferRecord["state"] })),
		declinedOffers: declined.map((d) => d.label),
	};
}

/** Substitui o estado da conversa (ofertas e rótulos declinados) numa transação, só dentro do escopo do dono. */
export async function saveAgentConversationState(userId: string, conversationId: string, state: AgentConversationStateRecord): Promise<void> {
	requireOwner(userId);
	checkText("conversationId", conversationId, LABEL_MAX);
	const offers = state.offers.slice(-AGENT_OFFERS_MAX).map((o, position) => {
		if (!OFFER_STATES.has(o.state)) throw new RangeError("state da oferta inválido");
		return { userId, conversationId, cardId: checkText("cardId", o.cardId, LABEL_MAX), label: checkText("label", o.label, LABEL_MAX), state: o.state, position };
	});
	const declined = [...new Set(state.declinedOffers.map((label) => checkText("label", label, LABEL_MAX)))].slice(-AGENT_DECLINED_MAX);
	await prisma.$transaction([
		prisma.agentConversationOffer.deleteMany({ where: { userId, conversationId } }),
		prisma.agentConversationDeclined.deleteMany({ where: { userId, conversationId } }),
		prisma.agentConversationOffer.createMany({ data: offers, skipDuplicates: true }),
		prisma.agentConversationDeclined.createMany({ data: declined.map((label) => ({ userId, conversationId, label })), skipDuplicates: true }),
	]);
}
