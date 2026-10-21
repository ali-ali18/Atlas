/**
 * Fusão determinística de deltas de lições (sem I/O). O refletor (LLM) propõe `add/update/helpful/harmful/retire`;
 * aqui o código decide o que muda, sempre do mesmo jeito: a mesma lista de lições e os mesmos deltas geram o mesmo
 * plano, e deltas que só somam contadores não dependem da ordem. Editar nunca reescreve a linha: cria uma versão
 * nova (`supersedesId`) e aposenta a anterior, para poder restaurar.
 */
import {
	compareLessons,
	lessonMatchesRef,
	normalizeForMatch,
	sanitizeLessonContent,
	sanitizeLessonEvidence,
	type LessonDelta,
	type LessonEvidence,
	type LessonOrigin,
	type LessonRule,
	type LessonScope,
} from "@workspace/shared";

export type PlanLesson = {
	id: string;
	scope: LessonScope;
	scopeKey: string | null;
	content: string;
	origin: LessonOrigin;
	evidence: LessonEvidence | null;
	helpful: number;
	harmful: number;
	uses: number;
	version: number;
	lastUsedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

export type NewLessonData = {
	scope: LessonScope;
	scopeKey: string | null;
	content: string;
	origin: LessonOrigin;
	evidence: LessonEvidence | null;
	rule: LessonRule | null;
	helpful: number;
	harmful: number;
	uses: number;
	version: number;
	supersedesId: string | null;
	lastUsedAt: Date | null;
};

export type LessonOp =
	| { type: "create"; data: NewLessonData }
	| { type: "retire"; id: string }
	| { type: "counter"; id: string; helpful: number; harmful: number };

export type LessonRejection = { delta: LessonDelta; reason: string };

export type LessonPlan = {
	ops: LessonOp[];
	rejected: LessonRejection[];
	/** Quantas lições ativas sobram depois das operações (para a trava de 60). */
	activeAfter: number;
	counts: { added: number; updated: number; retired: number; counters: number };
};

const sameText = (a: string, b: string) => normalizeForMatch(a) === normalizeForMatch(b);
const keyOf = (scope: LessonScope, scopeKey: string | null) => `${scope}\u0000${scopeKey ?? ""}`;

/** Lição ativa pelo id completo ou pela ref curta (`L1a2b`); ref ambígua não resolve. */
export function resolveLesson<T extends { id: string }>(active: readonly T[], idOrRef: string): T | null {
	const exact = active.find((lesson) => lesson.id === idOrRef.trim());
	if (exact) return exact;
	const hits = active.filter((lesson) => lessonMatchesRef(lesson.id, idOrRef));
	return hits.length === 1 ? hits[0]! : null;
}

export function planLessonDeltas(active: readonly PlanLesson[], deltas: readonly LessonDelta[]): LessonPlan {
	const rejected: LessonRejection[] = [];
	const reject = (delta: LessonDelta, reason: string) => rejected.push({ delta, reason });
	const adds: NewLessonData[] = [];
	const updates = new Map<string, { content: string; evidence: LessonEvidence | null }>();
	const retired = new Set<string>();
	const counters = new Map<string, { helpful: number; harmful: number }>();

	for (const delta of deltas) {
		if (delta.op === "add") {
			const content = sanitizeLessonContent(delta.content);
			const scopeKey = delta.scope === "bot" ? null : (delta.scopeKey?.trim() || null);
			if (!content) {
				reject(delta, "conteúdo vazio");
			} else if (delta.scope !== "bot" && !scopeKey) {
				reject(delta, "escopo sem chave");
			} else {
				const clash =
					active.some((lesson) => keyOf(lesson.scope, lesson.scopeKey) === keyOf(delta.scope, scopeKey) && sameText(lesson.content, content)) ||
					adds.some((item) => keyOf(item.scope, item.scopeKey) === keyOf(delta.scope, scopeKey) && sameText(item.content, content));
				if (clash) {
					reject(delta, "duplicada");
				} else {
					adds.push({ scope: delta.scope, scopeKey, content, origin: delta.origin, evidence: sanitizeLessonEvidence(delta.evidence), rule: delta.rule ?? null, helpful: 0, harmful: 0, uses: 0, version: 1, supersedesId: null, lastUsedAt: null });
				}
			}
			continue;
		}
		const target = resolveLesson(active, delta.id);
		if (!target) {
			reject(delta, "lição não encontrada");
			continue;
		}
		if (delta.op === "retire") {
			retired.add(target.id);
		} else if (delta.op === "update") {
			const content = sanitizeLessonContent(delta.content);
			if (!content) reject(delta, "conteúdo vazio");
			else if (sameText(target.content, content)) reject(delta, "sem mudança");
			else updates.set(target.id, { content, evidence: sanitizeLessonEvidence(delta.evidence) ?? target.evidence });
		} else {
			const current = counters.get(target.id) ?? { helpful: 0, harmful: 0 };
			if (delta.op === "helpful") current.helpful += 1;
			else current.harmful += 1;
			counters.set(target.id, current);
		}
	}

	const ops: LessonOp[] = [];
	for (const data of adds) ops.push({ type: "create", data });
	let updated = 0;
	for (const id of [...updates.keys()].sort()) {
		if (retired.has(id)) continue;
		const old = active.find((lesson) => lesson.id === id)!;
		const next = updates.get(id)!;
		const bump = counters.get(id) ?? { helpful: 0, harmful: 0 };
		ops.push({
			type: "create",
			data: {
				scope: old.scope,
				scopeKey: old.scopeKey,
				content: next.content,
				origin: old.origin,
				evidence: next.evidence,
				rule: null,
				helpful: old.helpful + bump.helpful,
				harmful: old.harmful + bump.harmful,
				uses: old.uses,
				version: old.version + 1,
				supersedesId: old.id,
				lastUsedAt: old.lastUsedAt,
			},
		});
		ops.push({ type: "retire", id });
		updated += 1;
	}
	let retiredCount = 0;
	for (const id of [...retired].sort()) {
		ops.push({ type: "retire", id });
		retiredCount += 1;
	}
	let counterCount = 0;
	for (const id of [...counters.keys()].sort()) {
		if (retired.has(id) || updates.has(id)) continue;
		const value = counters.get(id)!;
		ops.push({ type: "counter", id, helpful: value.helpful, harmful: value.harmful });
		counterCount += value.helpful + value.harmful;
	}
	const activeAfter = active.length - retiredCount + adds.length;
	return { ops, rejected, activeAfter, counts: { added: adds.length, updated, retired: retiredCount, counters: counterCount } };
}

/** Quem sai primeiro quando passa do teto: menor (útil − nociva), depois a usada/atualizada há mais tempo. */
export function pickEvictions<T extends { id: string; helpful: number; harmful: number; lastUsedAt: Date | null; updatedAt: Date; createdAt: Date }>(rows: readonly T[], count: number): T[] {
	if (count <= 0) return [];
	return [...rows].sort((a, b) => compareLessons(b, a)).slice(0, count);
}

export type DuplicatePair = { a: string; b: string; distance: number };

/**
 * De cada par quase idêntico (mesmo escopo), sai o pior dos dois, até liberar `needed` vagas.
 * Pares em ordem de distância (empate: ids), então o resultado não depende da ordem de entrada.
 */
export function chooseDuplicateLosers<T extends { id: string; helpful: number; harmful: number; lastUsedAt: Date | null; updatedAt: Date; createdAt: Date }>(rows: readonly T[], pairs: readonly DuplicatePair[], needed: number): string[] {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const gone = new Set<string>();
	const ordered = [...pairs].sort((x, y) => x.distance - y.distance || (x.a + x.b < y.a + y.b ? -1 : 1));
	for (const pair of ordered) {
		if (gone.size >= needed) break;
		const a = byId.get(pair.a);
		const b = byId.get(pair.b);
		if (!a || !b || gone.has(a.id) || gone.has(b.id)) continue;
		gone.add(compareLessons(a, b) <= 0 ? b.id : a.id);
	}
	return [...gone];
}
