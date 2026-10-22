/**
 * Lições do bot (memória procedural). Toda função recebe o `userId` da sessão/run e filtra por ele na própria query
 * (`where: { id, userId }`); lição ou bot de outro dono é indistinguível de inexistente (null / `not_found`).
 * A fusão de deltas é `planLessonDeltas` (pura); aqui só se carrega, executa em transação e aplica a trava de 60.
 */
import { Prisma } from "@prisma/client";
import {
	LESSON_AUTO_RETIRE_GAP,
	LESSON_MAX_ACTIVE,
	lessonRef,
	readLessonRule,
	sanitizeLessonEvidence,
	selectLessonsForInjection,
	type InjectableLesson,
	type LessonDelta,
	type LessonEvidence,
	type LessonFeedbackEntry,
	type LessonOrigin,
	type LessonRule,
	type LessonScope,
	type LessonView,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { SEMANTIC_DUP_MAX_DISTANCE, tryEmbed, vectorLiteral } from "./memory-entries.js";
import { chooseDuplicateLosers, pickEvictions, planLessonDeltas, resolveLesson, type DuplicatePair, type LessonOp, type LessonRejection, type PlanLesson } from "./lesson-deltas.js";

type LessonRow = {
	id: string;
	userId: string;
	botId: string;
	scope: string;
	scopeKey: string | null;
	content: string;
	origin: string;
	evidence: Prisma.JsonValue | null;
	rule?: Prisma.JsonValue | null;
	helpful: number;
	harmful: number;
	uses: number;
	status: string;
	version: number;
	supersedesId: string | null;
	createdAt: Date;
	updatedAt: Date;
	lastUsedAt: Date | null;
};

function toPlanLesson(row: LessonRow): PlanLesson {
	return {
		id: row.id,
		scope: row.scope as LessonScope,
		scopeKey: row.scopeKey,
		content: row.content,
		origin: row.origin as LessonOrigin,
		evidence: sanitizeLessonEvidence(row.evidence),
		rule: readLessonRule(row.rule),
		helpful: row.helpful,
		harmful: row.harmful,
		uses: row.uses,
		version: row.version,
		lastUsedAt: row.lastUsedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function toLessonView(row: LessonRow, canRestore = false): LessonView {
	return {
		id: row.id,
		ref: lessonRef(row.id),
		scope: row.scope as LessonScope,
		scopeKey: row.scopeKey,
		content: row.content,
		origin: row.origin as LessonOrigin,
		evidence: sanitizeLessonEvidence(row.evidence),
		rule: readLessonRule(row.rule),
		helpful: row.helpful,
		harmful: row.harmful,
		uses: row.uses,
		status: row.status === "retired" ? "retired" : "active",
		version: row.version,
		supersedesId: row.supersedesId,
		canRestore,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
	};
}

async function ownsBot(userId: string, botId: string): Promise<boolean> {
	if (!userId.trim() || !botId.trim()) return false;
	return Boolean(await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { id: true } }));
}

async function activeRows(userId: string, botId: string): Promise<LessonRow[]> {
	return (await prisma.botLesson.findMany({ where: { userId, botId, status: "active" }, orderBy: { createdAt: "asc" } })) as LessonRow[];
}

export type LessonDeps = {
	embed?: (text: string) => Promise<number[] | null>;
	duplicatePairs?: (botId: string) => Promise<DuplicatePair[]>;
};

async function storeLessonEmbedding(id: string, vector: number[]): Promise<void> {
	await prisma.$executeRaw`UPDATE bot_lessons SET embedding = ${vectorLiteral(vector)}::vector WHERE id = ${id}`;
}

/** Pares de lições ativas do bot (mesmo escopo e chave) quase idênticas pelo vetor. */
async function nearDuplicatePairs(botId: string): Promise<DuplicatePair[]> {
	const rows = await prisma.$queryRaw<Array<{ a: string; b: string; distance: number }>>`SELECT a.id AS a, b.id AS b, a.embedding <=> b.embedding AS distance
		FROM bot_lessons a JOIN bot_lessons b
			ON b."botId" = a."botId" AND a.id < b.id AND a.scope = b.scope AND COALESCE(a."scopeKey", '') = COALESCE(b."scopeKey", '')
		WHERE a."botId" = ${botId} AND a.status = 'active' AND b.status = 'active'
			AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
			AND a.embedding <=> b.embedding < ${SEMANTIC_DUP_MAX_DISTANCE}`;
	return rows.map((row) => ({ a: row.a, b: row.b, distance: Number(row.distance) }));
}

async function retireIds(userId: string, botId: string, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	await prisma.botLesson.updateMany({ where: { userId, botId, id: { in: ids } }, data: { status: "retired" } });
}

/**
 * Trava preguiçosa: só quando passa de 60 ativas. Primeiro de-duplica por embedding (sai o pior de cada par quase
 * idêntico), depois aposenta as de menor (útil − nociva) e menos usadas. Devolve os ids aposentados.
 */
export async function enforceLessonCap(userId: string, botId: string, deps: LessonDeps = {}, max = LESSON_MAX_ACTIVE): Promise<string[]> {
	const rows = await activeRows(userId, botId);
	if (rows.length <= max) return [];
	const retired: string[] = [];
	let excess = rows.length - max;
	try {
		const pairs = await (deps.duplicatePairs ?? nearDuplicatePairs)(botId);
		const losers = chooseDuplicateLosers(rows, pairs, excess);
		await retireIds(userId, botId, losers);
		retired.push(...losers);
		excess -= losers.length;
	} catch (error) {
		console.warn("lesson dedupe failed; using eviction only", error instanceof Error ? error.message : error);
	}
	if (excess > 0) {
		const left = rows.filter((row) => !retired.includes(row.id));
		const out = pickEvictions(left, excess).map((row) => row.id);
		await retireIds(userId, botId, out);
		retired.push(...out);
	}
	return retired;
}

export type ApplyLessonResult =
	| {
			ok: true;
			added: number;
			updated: number;
			retired: number;
			counters: number;
			evicted: number;
			rejected: LessonRejection[];
			createdIds: string[];
	  }
	| { ok: false; error: "not_found" };

/**
 * Aplica os deltas do refletor (ou da UI) numa transação. Determinístico: ver `planLessonDeltas`. O dono do bot é
 * conferido; `userId` de outro dono = `not_found`. Vetores e a trava de 60 vêm depois, fora da transação.
 */
export async function applyLessonDeltas(botId: string, deltas: readonly LessonDelta[], opts: { userId: string }, deps: LessonDeps = {}): Promise<ApplyLessonResult> {
	const { userId } = opts;
	if (!(await ownsBot(userId, botId))) return { ok: false, error: "not_found" };
	const rows = await activeRows(userId, botId);
	const plan = planLessonDeltas(rows.map(toPlanLesson), deltas);
	const created: Array<{ id: string; content: string }> = [];
	if (plan.ops.length > 0) {
		await prisma.$transaction(async (tx) => {
			for (const op of plan.ops) await runOp(tx, userId, botId, op, created);
		});
	}
	const embed = deps.embed ?? tryEmbed;
	for (const item of created) {
		const vector = await embed(item.content).catch(() => null);
		if (vector) await storeLessonEmbedding(item.id, vector).catch((error) => console.warn("lesson embedding store failed", error));
	}
	const evicted = plan.activeAfter > LESSON_MAX_ACTIVE ? await enforceLessonCap(userId, botId, deps) : [];
	return { ok: true, ...plan.counts, evicted: evicted.length, rejected: plan.rejected, createdIds: created.map((item) => item.id) };
}

type Tx = Prisma.TransactionClient;

async function runOp(tx: Tx, userId: string, botId: string, op: LessonOp, created: Array<{ id: string; content: string }>): Promise<void> {
	if (op.type === "create") {
		const row = await tx.botLesson.create({
			data: {
				userId,
				botId,
				scope: op.data.scope,
				scopeKey: op.data.scopeKey,
				content: op.data.content,
				origin: op.data.origin,
				evidence: (op.data.evidence ?? undefined) as Prisma.InputJsonValue | undefined,
				rule: (op.data.rule ?? undefined) as Prisma.InputJsonValue | undefined,
				helpful: op.data.helpful,
				harmful: op.data.harmful,
				uses: op.data.uses,
				version: op.data.version,
				supersedesId: op.data.supersedesId,
				lastUsedAt: op.data.lastUsedAt,
			},
		});
		created.push({ id: row.id, content: op.data.content });
	} else if (op.type === "retire") {
		await tx.botLesson.updateMany({ where: { id: op.id, userId, botId }, data: { status: "retired" } });
	} else {
		await tx.botLesson.updateMany({
			where: { id: op.id, userId, botId, status: "active" },
			data: { ...(op.helpful ? { helpful: { increment: op.helpful } } : {}), ...(op.harmful ? { harmful: { increment: op.harmful } } : {}) },
		});
	}
}

/** Lições do bot para a UI: ativas, mais a marca de "dá para restaurar a versão anterior". */
export async function listBotLessons(userId: string, botId: string): Promise<LessonView[]> {
	if (!(await ownsBot(userId, botId))) return [];
	const rows = await activeRows(userId, botId);
	const parents = rows.map((row) => row.supersedesId).filter((id): id is string => Boolean(id));
	const existing = parents.length > 0 ? ((await prisma.botLesson.findMany({ where: { userId, botId, id: { in: parents } } })) as LessonRow[]) : [];
	const restorable = new Set(existing.map((row) => row.id));
	return rows
		.map((row) => toLessonView(row, Boolean(row.supersedesId && restorable.has(row.supersedesId))))
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function getBotLesson(userId: string, lessonId: string): Promise<LessonView | null> {
	const row = (await prisma.botLesson.findFirst({ where: { id: lessonId, userId } })) as LessonRow | null;
	return row ? toLessonView(row) : null;
}

/** Texto novo (edição do usuário): vira versão nova, a anterior fica para restaurar. Null = não é do usuário/aposentada. */
export async function updateBotLessonContent(userId: string, lessonId: string, content: string): Promise<LessonView | null> {
	const row = (await prisma.botLesson.findFirst({ where: { id: lessonId, userId, status: "active" } })) as LessonRow | null;
	if (!row) return null;
	const result = await applyLessonDeltas(row.botId, [{ op: "update", id: row.id, content }], { userId });
	if (!result.ok) return null;
	const newId = result.createdIds[0];
	if (!newId) return toLessonView(row);
	const fresh = (await prisma.botLesson.findFirst({ where: { id: newId, userId } })) as LessonRow | null;
	return fresh ? toLessonView(fresh, true) : null;
}

/** Liga, troca ou tira a regra (hooks) de uma lição ativa do usuário, no lugar (a regra não muda o texto nem a versão). Null = não é do usuário/aposentada. */
export async function setBotLessonRule(userId: string, lessonId: string, rule: LessonRule | null): Promise<LessonView | null> {
	const row = (await prisma.botLesson.findFirst({ where: { id: lessonId, userId, status: "active" } })) as LessonRow | null;
	if (!row) return null;
	await prisma.botLesson.updateMany({ where: { id: row.id, userId }, data: { rule: rule ? (rule as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
	return toLessonView({ ...row, rule: rule as unknown as Prisma.JsonValue | null });
}

/** "Apagar" na UI: aposenta (o histórico fica). Null = não é do usuário. */
export async function retireBotLesson(userId: string, lessonId: string): Promise<LessonView | null> {
	const row = (await prisma.botLesson.findFirst({ where: { id: lessonId, userId } })) as LessonRow | null;
	if (!row) return null;
	await prisma.botLesson.updateMany({ where: { id: row.id, userId }, data: { status: "retired" } });
	return toLessonView({ ...row, status: "retired" });
}

/** Restaura a versão que esta substituiu: a atual é aposentada e a anterior volta a ativa. Null = nada a restaurar. */
export async function restoreBotLessonVersion(userId: string, lessonId: string): Promise<LessonView | null> {
	const row = (await prisma.botLesson.findFirst({ where: { id: lessonId, userId, status: "active" } })) as LessonRow | null;
	if (!row?.supersedesId) return null;
	const previous = (await prisma.botLesson.findFirst({ where: { id: row.supersedesId, userId, botId: row.botId } })) as LessonRow | null;
	if (!previous) return null;
	await prisma.$transaction(async (tx) => {
		await tx.botLesson.updateMany({ where: { id: row.id, userId }, data: { status: "retired" } });
		await tx.botLesson.updateMany({ where: { id: previous.id, userId }, data: { status: "active" } });
	});
	return toLessonView({ ...previous, status: "active" });
}

/** Lições ativas do bot na forma que o prompt usa (já com escopo e teto; `scopeKeys` = conectores/tools carregados). */
export async function listLessonsForPrompt(
	userId: string,
	botId: string,
	opts: { scopeKeys?: readonly string[]; onlyScopes?: readonly LessonScope[] } = {},
): Promise<Array<InjectableLesson & { origin: LessonOrigin }>> {
	if (!userId.trim() || !botId.trim()) return [];
	const rows = await activeRows(userId, botId);
	const items = rows.map((row) => ({ ...toPlanLesson(row), status: row.status }));
	return selectLessonsForInjection(items, opts);
}

export type LessonFeedbackResult = { applied: string[]; unknown: string[]; retired: string[] };

/**
 * O modelo marcou lições que usou: `uses` sobe sempre, `helpful` se ajudou, `harmful` se atrapalhou. Se a diferença
 * (nociva − útil) chegar a 3, a lição se aposenta sozinha. Só as lições ativas deste bot e dono são encontradas.
 */
export async function recordLessonFeedback(userId: string, botId: string, entries: readonly LessonFeedbackEntry[], now: Date = new Date()): Promise<LessonFeedbackResult> {
	const result: LessonFeedbackResult = { applied: [], unknown: [], retired: [] };
	if (entries.length === 0 || !userId.trim() || !botId.trim()) return result;
	const rows = await activeRows(userId, botId);
	for (const entry of entries) {
		const target = resolveLesson(rows, entry.ref);
		if (!target) {
			result.unknown.push(entry.ref);
			continue;
		}
		await prisma.botLesson.updateMany({
			where: { id: target.id, userId, botId },
			data: {
				uses: { increment: 1 },
				lastUsedAt: now,
				...(entry.outcome === "helped" ? { helpful: { increment: 1 } } : {}),
				...(entry.outcome === "hurt" ? { harmful: { increment: 1 } } : {}),
			},
		});
		result.applied.push(target.id);
		const harmful = target.harmful + (entry.outcome === "hurt" ? 1 : 0);
		const helpful = target.helpful + (entry.outcome === "helped" ? 1 : 0);
		if (harmful - helpful >= LESSON_AUTO_RETIRE_GAP) {
			await retireIds(userId, botId, [target.id]);
			result.retired.push(target.id);
		}
	}
	return result;
}

export type { LessonEvidence };
