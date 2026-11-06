/**
 * Store do motor v4 (F1.12): journal de efeitos, recibos, notas, ofertas por conversa e checkpoint por passo.
 * Tabelas NOVAS (migration aditiva `agent_v4_store`); o checkpoint vai em `AgentRun.checkpointJson` sob a chave `v4`,
 * por merge de jsonb, sem tocar nas chaves que o v1/v2 gravam.
 *
 * Toda função recebe o `userId` do RUN (nunca do modelo) e filtra por ele (`ownerIds`): dono vazio ou `"default"` não
 * lê nem escreve nada, e o recurso de outro dono é "não encontrado". Os tipos são estruturais (iguais aos das portas
 * de `@workspace/agent`) para o db não depender do motor.
 */
import { randomUUID } from "node:crypto";
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
 * Grava o checkpoint do v4 em `checkpointJson.v4` (merge jsonb atômico; as outras chaves ficam). Exige o lease desta
 * execução (mesma cerca do `saveAgentRunCheckpoint`): sem lease não há gravação (`lease_required`), e lease perdido ou
 * vencido → `lease_lost`. Assim um worker zumbi não sobrescreve o checkpoint de quem assumiu o run (S10).
 */
export async function saveAgentV4Checkpoint(userId: string, checkpoint: AgentV4Checkpoint, lease: Pick<RunLease, "owner" | "token"> | null | undefined): Promise<void> {
	requireOwner(userId);
	if (!lease) throw new Error("lease_required");
	const patch = checkpointPatch(checkpoint);
	const updated = await prisma.$executeRaw`
		UPDATE "agent_runs"
		SET "checkpointJson" = COALESCE("checkpointJson", '{}'::jsonb) || ${patch}::jsonb
		WHERE "id" = ${checkpoint.runId} AND "userId" = ${userId}
			AND "leaseOwner" = ${lease.owner} AND "leaseToken" = ${lease.token} AND "leaseUntil" > now()`;
	if (updated === 0) throw new Error("lease_lost");
}

/** SEM cerca de lease: só para teste e manutenção explícita. O motor nunca chama (use `saveAgentV4Checkpoint`). */
export async function saveAgentV4CheckpointUnfenced(userId: string, checkpoint: AgentV4Checkpoint): Promise<void> {
	requireOwner(userId);
	const updated = await prisma.$executeRaw`
		UPDATE "agent_runs"
		SET "checkpointJson" = COALESCE("checkpointJson", '{}'::jsonb) || ${checkpointPatch(checkpoint)}::jsonb
		WHERE "id" = ${checkpoint.runId} AND "userId" = ${userId}`;
	if (updated === 0) throw new ResourceOwnershipError();
}

/**
 * O jsonb do Postgres recusa `\u0000` e surrogate solto, que podem vir no texto do modelo ou nos args que ele mandou
 * (a saída de tool já chega saneada). Troca só no JSON gravado, sem clonar o estado, e só o escape que não é uma barra
 * escapada (`\\u0000` é texto literal). Para a tela nada muda: o texto ao vivo já saiu pelo stream.
 */
const JSON_UNICODE_ESCAPE = /(\\+)u([0-9a-fA-F]{4})/g;
const isHigh = (hex: string) => /^d[89ab]/i.test(hex);
const isLow = (hex: string) => /^d[c-f]/i.test(hex);
export function jsonbSafe(json: string): string {
	let prevHighEnd = -1;
	return json.replace(JSON_UNICODE_ESCAPE, (match, slashes: string, hex: string, offset: number) => {
		if (slashes.length % 2 === 0) return match; // `\\u0000`: barra escapada seguida de texto literal
		const keep = slashes.slice(0, -1);
		const end = offset + match.length;
		if (hex === "0000") return `${keep}\\ufffd`;
		if (isHigh(hex)) {
			const next = /^\\u([0-9a-fA-F]{4})/.exec(json.slice(end));
			if (next && isLow(next[1]!)) {
				prevHighEnd = end;
				return match;
			}
			return `${keep}\\ufffd`;
		}
		if (isLow(hex) && prevHighEnd !== offset) return `${keep}\\ufffd`;
		return match;
	});
}

const checkpointPatch = (checkpoint: AgentV4Checkpoint): string => jsonbSafe(JSON.stringify({ v4: { step: checkpoint.step, state: checkpoint.state, payload: checkpoint.payload } }));

/**
 * O lease do run ainda é desta execução (dono, token e validade)? Senão lança `lease_lost`. O executor do motor chama
 * antes de cada efeito (S5): um worker zumbi, de lease vencido, não repete `send`/`money` que outro worker já assumiu.
 */
export async function assertAgentV4Lease(userId: string, runId: string, lease: Pick<RunLease, "owner" | "token">): Promise<void> {
	if (!owned(userId)) throw new ResourceOwnershipError();
	const rows = await prisma.$queryRaw<Array<{ ok: number }>>`
		SELECT 1 AS "ok" FROM "agent_runs"
		WHERE "id" = ${runId} AND "userId" = ${userId}
			AND "leaseOwner" = ${lease.owner} AND "leaseToken" = ${lease.token} AND "leaseUntil" > now()`;
	if (rows.length === 0) throw new Error("lease_lost");
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
 * Grava a entrada do journal numa instrução só (INSERT … ON CONFLICT pela chave de idempotência, por dono e run), então
 * dois processos disputando a mesma chave nunca passam os dois. O run precisa ser do dono (senão "não encontrado").
 *
 * Transições: `started` é o CLAIM da escrita. Cria a entrada, ou reassume uma `failed` (a nova tentativa volta a
 * `started`, para uma retomada interrompida ser detectável: B10); sobre `started`/`succeeded` não muda nada e devolve
 * `claimed: false` (outro processo já tem a escrita, ou ela já terminou). `succeeded` e `failed` fecham a entrada e
 * `succeeded` nunca é rebaixado.
 */
export async function appendAgentJournalEntry(entry: AgentJournalRecord): Promise<{ claimed: boolean }> {
	requireOwner(entry.userId);
	if (!OUTCOMES.has(entry.outcome)) throw new RangeError("outcome inválido");
	checkText("idempotencyKey", entry.idempotencyKey, LABEL_MAX);
	const toolName = checkText("toolName", entry.toolName, LABEL_MAX);
	const argsHash = checkText("argsHash", entry.argsHash, LABEL_MAX);
	const id = randomUUID();
	const rows =
		entry.outcome === "started"
			? await prisma.$queryRaw<Array<{ id: string }>>`
				INSERT INTO "agent_journal_entries" AS j ("id", "runId", "userId", "step", "idempotencyKey", "toolName", "argsHash", "state", "createdAt", "updatedAt")
				SELECT ${id}, r."id", r."userId", ${entry.step}::int, ${entry.idempotencyKey}, ${toolName}, ${argsHash}, 'started', now(), now()
				FROM "agent_runs" r WHERE r."id" = ${entry.runId} AND r."userId" = ${entry.userId}
				ON CONFLICT ("userId", "runId", "idempotencyKey") DO UPDATE SET "state" = 'started', "step" = EXCLUDED."step", "updatedAt" = now()
				WHERE j."state" = 'failed'
				RETURNING j."id"`
			: await prisma.$queryRaw<Array<{ id: string }>>`
				INSERT INTO "agent_journal_entries" AS j ("id", "runId", "userId", "step", "idempotencyKey", "toolName", "argsHash", "state", "createdAt", "updatedAt")
				SELECT ${id}, r."id", r."userId", ${entry.step}::int, ${entry.idempotencyKey}, ${toolName}, ${argsHash}, ${entry.outcome}, now(), now()
				FROM "agent_runs" r WHERE r."id" = ${entry.runId} AND r."userId" = ${entry.userId}
				ON CONFLICT ("userId", "runId", "idempotencyKey") DO UPDATE SET "state" = CASE WHEN j."state" = 'succeeded' THEN 'succeeded' ELSE EXCLUDED."state" END, "step" = EXCLUDED."step", "updatedAt" = now()
				RETURNING j."id"`;
	if (rows.length > 0) return { claimed: true };
	// Nenhuma linha: ou o run não é do dono, ou a chave já está com `started`/`succeeded` (claim perdido).
	const run = await prisma.agentRun.findFirst({ where: { id: entry.runId, userId: entry.userId }, select: { id: true } });
	if (!run) throw new ResourceOwnershipError();
	return { claimed: false };
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
	// Os vínculos da nota têm de ser do mesmo dono: bot e run de outro usuário são "não encontrado" (S10).
	if (note.botId && !(await prisma.bot.findFirst({ where: { id: note.botId, ownerId: note.userId }, select: { id: true } }))) throw new ResourceOwnershipError();
	if (note.sourceRunId && !(await prisma.agentRun.findFirst({ where: { id: note.sourceRunId, userId: note.userId }, select: { id: true } }))) throw new ResourceOwnershipError();
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

/**
 * Substitui o estado da conversa (ofertas e rótulos declinados) numa transação serializada por conversa (lock
 * consultivo): duas gravações simultâneas não se intercalam. Os rótulos declinados NÃO são apagados e recriados: cada
 * um é `upsert` (o que já existe mantém o `createdAt`, então a ordem de inserção sobrevive) e só os que saíram da lista
 * são removidos. Rótulo novo ganha `createdAt` crescente na ordem recebida (B16).
 */
export async function saveAgentConversationState(userId: string, conversationId: string, state: AgentConversationStateRecord): Promise<void> {
	requireOwner(userId);
	checkText("conversationId", conversationId, LABEL_MAX);
	const offers = state.offers.slice(-AGENT_OFFERS_MAX).map((o, position) => {
		if (!OFFER_STATES.has(o.state)) throw new RangeError("state da oferta inválido");
		return { userId, conversationId, cardId: checkText("cardId", o.cardId, LABEL_MAX), label: checkText("label", o.label, LABEL_MAX), state: o.state, position };
	});
	const declined = [...new Set(state.declinedOffers.map((label) => checkText("label", label, LABEL_MAX)))].slice(-AGENT_DECLINED_MAX);
	const base = Date.now();
	await prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent_conversation:${userId}:${conversationId}`}))`;
		await tx.agentConversationOffer.deleteMany({ where: { userId, conversationId } });
		await tx.agentConversationOffer.createMany({ data: offers, skipDuplicates: true });
		for (const [index, label] of declined.entries()) {
			await tx.agentConversationDeclined.upsert({
				where: { userId_conversationId_label: { userId, conversationId, label } },
				create: { userId, conversationId, label, createdAt: new Date(base + index) },
				update: {},
			});
		}
		await tx.agentConversationDeclined.deleteMany({ where: { userId, conversationId, label: { notIn: declined } } });
	});
}
