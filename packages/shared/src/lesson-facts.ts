/**
 * Lições viram fatos (motor v3, PR8c). Decisão PURA (sem I/O, sem relógio: `now` entra por parâmetro) de o que cada
 * lição existente vira na memória do bot: fato, junção com outra ou descarte. Quem lê o banco e quem aplica ficam em
 * `packages/db/src/lesson-migration.ts`; aqui só normaliza, deduplica, acha conflito e renderiza o relatório.
 * É sugestão para o dono revisar: nada aqui grava, e o texto de lição passa por `redactSecrets` antes de qualquer saída.
 */
import { redactSecrets } from "./redact-secrets.js";
import { LESSON_AUTO_RETIRE_GAP, type LessonScope } from "./lessons.js";

/** Fato maior que isso não vira fato sozinho: o dono encurta à mão. */
export const FACT_MAX_CHARS = 400;
/** Semelhança de palavras a partir da qual duas lições são a mesma. */
export const FACT_DUPLICATE_SIMILARITY = 0.85;
/** Semelhança mínima (sem contar negações) para duas lições tratarem do mesmo assunto e poderem se contradizer. */
export const FACT_CONFLICT_SIMILARITY = 0.5;
/** Lição nunca usada, sem voto e parada há tanto tempo é considerada obsoleta. */
export const FACT_STALE_DAYS = 180;

export type LessonFactInput = {
	id: string;
	ref?: string;
	scope: LessonScope;
	scopeKey: string | null;
	content: string;
	helpful: number;
	harmful: number;
	uses: number;
	/** ISO. */
	createdAt: string;
	updatedAt: string;
	lastUsedAt?: string | null;
};

export type LessonFactDecision = "fact" | "merge" | "discard";
export type LessonFactReason =
	| "ok"
	| "empty"
	| "secret"
	| "obsolete_harmful"
	| "obsolete_stale"
	| "too_long"
	| "duplicate"
	| "duplicate_of_fact"
	| "conflict_loser"
	| "over_budget";

export type LessonFactItem = {
	lessonId: string;
	ref: string;
	scope: LessonScope;
	scopeKey: string | null;
	/** Texto da lição, já com segredos redigidos. */
	original: string;
	/** Texto do fato proposto (vazio quando a decisão é descartar). */
	factText: string;
	decision: LessonFactDecision;
	reason: LessonFactReason;
	/** Decisão `merge`: id da lição que fica no lugar desta. */
	mergeIntoId?: string;
	/** Ids das lições que dizem o contrário. */
	conflictWith: string[];
	/** O dono precisa olhar antes (conflito): a aplicação NÃO grava o que está marcado. */
	needsReview: boolean;
};

export type LessonFactPlan = {
	items: LessonFactItem[];
	counts: { total: number; fact: number; merge: number; discard: number; needsReview: number };
};

export type PlanLessonFactsInput = {
	lessons: readonly LessonFactInput[];
	/** Textos dos fatos que já existem na memória do bot (para não repetir). */
	existingFacts?: readonly string[];
	now: Date;
	/** Espaço da memória do bot: `limit` total de caracteres e `used` já ocupado. Sem isso, não há teto. */
	budget?: { limit: number; used: number };
};

const NEGATIONS = new Set(["nao", "nunca", "jamais", "evite", "evitar", "sem", "never", "not", "dont", "avoid", "cannot", "cant"]);
const STOPWORDS = new Set(["para", "com", "uma", "que", "por", "dos", "das", "nos", "nas", "the", "and", "for", "ao", "aos", "ser", "seu", "sua", "como", "quando", "porque"]);

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Minúsculas, sem acento nem pontuação: base de comparação (nunca de exibição). */
export function normalizeFactText(text: string): string {
	return collapse(
		text
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " "),
	);
}

function tokens(text: string, opts: { dropNegations?: boolean } = {}): Set<string> {
	const out = new Set<string>();
	for (const word of normalizeFactText(text).split(" ")) {
		if (word.length < 3 && !NEGATIONS.has(word)) continue;
		if (STOPWORDS.has(word)) continue;
		if (opts.dropNegations && NEGATIONS.has(word)) continue;
		out.add(word);
	}
	return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared += 1;
	return shared / (a.size + b.size - shared);
}

function negated(text: string): boolean {
	for (const word of normalizeFactText(text).split(" ")) if (NEGATIONS.has(word)) return true;
	return false;
}

/** Texto do fato: a lição como está; de conector ou tool leva o contexto na frente para não perder o "onde vale". */
export function factTextFor(lesson: Pick<LessonFactInput, "scope" | "scopeKey">, content: string): string {
	if (lesson.scope === "bot" || !lesson.scopeKey) return content;
	return `(${lesson.scope === "connector" ? "conector" : "ferramenta"} ${lesson.scopeKey}) ${content}`;
}

function score(lesson: LessonFactInput): number[] {
	return [lesson.helpful - lesson.harmful, lesson.uses, Date.parse(lesson.updatedAt) || 0];
}

/** Melhor primeiro; empate final por id para a saída ser determinística. */
function compareBest(a: LessonFactInput, b: LessonFactInput): number {
	const sa = score(a);
	const sb = score(b);
	for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return (sb[i] as number) - (sa[i] as number);
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type Work = { lesson: LessonFactInput; item: LessonFactItem };

export function planLessonFacts(input: PlanLessonFactsInput): LessonFactPlan {
	const staleBefore = input.now.getTime() - FACT_STALE_DAYS * 86_400_000;
	const work: Work[] = input.lessons.map((lesson) => {
		const raw = collapse(lesson.content ?? "");
		const original = redactSecrets(raw);
		const item: LessonFactItem = {
			lessonId: lesson.id,
			ref: lesson.ref ?? lesson.id.slice(-4),
			scope: lesson.scope,
			scopeKey: lesson.scopeKey,
			original,
			factText: factTextFor(lesson, original),
			decision: "fact",
			reason: "ok",
			conflictWith: [],
			needsReview: false,
		};
		return { lesson, item };
	});

	const discard = (entry: Work, reason: LessonFactReason) => {
		entry.item.decision = "discard";
		entry.item.reason = reason;
		entry.item.factText = "";
	};

	// 1) descartes individuais
	for (const entry of work) {
		const { lesson, item } = entry;
		if (!item.original) discard(entry, "empty");
		else if (item.original !== collapse(lesson.content)) discard(entry, "secret");
		else if (lesson.harmful - lesson.helpful >= LESSON_AUTO_RETIRE_GAP) discard(entry, "obsolete_harmful");
		else if (lesson.uses === 0 && lesson.helpful === 0 && lesson.harmful === 0 && (Date.parse(lesson.updatedAt) || 0) < staleBefore) discard(entry, "obsolete_stale");
		else if (item.factText.length > FACT_MAX_CHARS) discard(entry, "too_long");
	}

	// 2) duplicadas entre si (a melhor fica) e já presentes na memória
	const existing = (input.existingFacts ?? []).map((text) => ({ norm: normalizeFactText(text), tokens: tokens(text) }));
	const kept: Work[] = [];
	for (const entry of work.filter((w) => w.item.decision === "fact").sort((a, b) => compareBest(a.lesson, b.lesson))) {
		const norm = normalizeFactText(entry.item.factText);
		const tk = tokens(entry.item.factText);
		if (existing.some((fact) => fact.norm === norm || jaccard(fact.tokens, tk) >= FACT_DUPLICATE_SIMILARITY)) {
			discard(entry, "duplicate_of_fact");
			continue;
		}
		const twin = kept.find((other) => normalizeFactText(other.item.factText) === norm || jaccard(tokens(other.item.factText), tk) >= FACT_DUPLICATE_SIMILARITY);
		if (twin) {
			entry.item.decision = "merge";
			entry.item.reason = "duplicate";
			entry.item.mergeIntoId = twin.lesson.id;
			entry.item.factText = "";
			continue;
		}
		kept.push(entry);
	}

	// 3) conflito: mesmo assunto (sem contar negações) e polaridade oposta. Quem tem pior placar sai; empate pede revisão.
	for (let i = 0; i < kept.length; i += 1) {
		for (let j = i + 1; j < kept.length; j += 1) {
			const a = kept[i]!;
			const b = kept[j]!;
			if (a.item.decision !== "fact" || b.item.decision !== "fact") continue;
			if (negated(a.item.original) === negated(b.item.original)) continue;
			if (jaccard(tokens(a.item.original, { dropNegations: true }), tokens(b.item.original, { dropNegations: true })) < FACT_CONFLICT_SIMILARITY) continue;
			a.item.conflictWith.push(b.lesson.id);
			b.item.conflictWith.push(a.lesson.id);
			a.item.needsReview = true;
			b.item.needsReview = true;
			// `kept` já está do melhor para o pior: só o placar estritamente melhor de `a` rebaixa `b`.
			if (compareBest(a.lesson, b.lesson) < 0 && score(a.lesson)[0] !== score(b.lesson)[0]) {
				discard(b, "conflict_loser");
				b.item.needsReview = true;
			}
		}
	}

	// 4) espaço da memória do bot
	if (input.budget) {
		let used = input.budget.used;
		for (const entry of kept) {
			if (entry.item.decision !== "fact") continue;
			const size = entry.item.factText.length;
			if (used + size > input.budget.limit) {
				discard(entry, "over_budget");
				continue;
			}
			used += size;
		}
	}

	const items = work.map((w) => w.item);
	const count = (decision: LessonFactDecision) => items.filter((item) => item.decision === decision).length;
	return { items, counts: { total: items.length, fact: count("fact"), merge: count("merge"), discard: count("discard"), needsReview: items.filter((item) => item.needsReview).length } };
}

/** Itens que a aplicação pode gravar: viram fato e nenhum conflito pede revisão. */
export function applicableFacts(plan: LessonFactPlan): LessonFactItem[] {
	return plan.items.filter((item) => item.decision === "fact" && !item.needsReview && item.factText.length > 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Relatório em markdown
// ---------------------------------------------------------------------------------------------------------------------

export const FACT_REASON_LABEL: Record<LessonFactReason, string> = {
	ok: "vira fato",
	empty: "vazia",
	secret: "continha segredo (redigido); não vira fato",
	obsolete_harmful: "obsoleta: mais nociva que útil",
	obsolete_stale: "obsoleta: nunca usada e parada há muito tempo",
	too_long: "grande demais para um fato; encurte à mão",
	duplicate: "duplicada: junta com a lição indicada",
	duplicate_of_fact: "a memória já tem esse fato",
	conflict_loser: "contradiz uma lição com placar melhor",
	over_budget: "não cabe no espaço da memória do bot",
};

export type LessonFactReportOwner = { userId: string; botId: string; plan: LessonFactPlan };

function inline(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
}

/** Relatório por dono e bot. Só texto já redigido; um dono nunca aparece na seção do outro. */
export function renderLessonFactsReport(owners: readonly LessonFactReportOwner[], generatedAt: Date): string {
	const lines = [
		"# Lições → fatos (relatório, somente leitura)",
		"",
		`Gerado em ${generatedAt.toISOString()}. Nada foi gravado: este relatório só sugere. A aplicação exige o ok do dono e a flag \`--apply\`.`,
		"",
	];
	if (owners.length === 0) lines.push("Nenhuma lição ativa encontrada.", "");
	for (const owner of owners) {
		const { counts } = owner.plan;
		lines.push(`## Dono ${owner.userId} · bot ${owner.botId}`, "", `Lições: ${counts.total} · virariam fato: ${counts.fact} · juntar: ${counts.merge} · descartar: ${counts.discard} · exigem revisão: ${counts.needsReview}`, "");
		for (const item of owner.plan.items) {
			const scope = item.scope === "bot" ? "bot" : `${item.scope} ${item.scopeKey ?? ""}`.trim();
			const verb = item.decision === "fact" ? "VIRAR FATO" : item.decision === "merge" ? `JUNTAR com ${item.mergeIntoId}` : "DESCARTAR";
			lines.push(`- [${item.ref}] (${scope}) **${verb}** · ${FACT_REASON_LABEL[item.reason]}${item.needsReview ? " · REVISAR" : ""}`);
			lines.push(`  - lição: ${inline(item.original) || "(vazia)"}`);
			if (item.decision === "fact") lines.push(`  - fato: ${inline(item.factText)}`);
			if (item.conflictWith.length > 0) lines.push(`  - conflita com: ${item.conflictWith.join(", ")}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}
