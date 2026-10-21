/**
 * Lições do bot (memória procedural): itens curtos com id, contadores de utilidade e escopo.
 * Cada item vira "Ao X, faça Y — porque Z". O LLM só propõe DELTAS (add/update/helpful/harmful/retire);
 * quem funde é código determinístico (`planLessonDeltas` no db), nunca uma reescrita completa.
 * Tudo aqui é puro (sem I/O): tipos, limites, renderização, seleção e a checagem de proveniência.
 */
import { redactSecrets } from "./redact-secrets.js";

export const LESSON_MAX_CHARS = 280;
export const LESSON_EVIDENCE_QUOTE_MAX = 300;
export const LESSON_MAX_ACTIVE = 60;
/** Injeção no prompt: pequena e escopada (conjuntos grandes e ruidosos apagam o ganho). */
export const LESSON_INJECT_MAX_ITEMS = 40;
export const LESSON_INJECT_MAX_CHARS = 3_000;
/** harmful − helpful a partir daqui aposenta a lição sozinha. */
export const LESSON_AUTO_RETIRE_GAP = 3;
export const LESSON_REF_LENGTH = 4;

export const LESSON_SCOPES = ["bot", "connector", "tool"] as const;
export type LessonScope = (typeof LESSON_SCOPES)[number];
export const LESSON_ORIGINS = ["correction", "failure_recovery", "failed_action", "reflection", "user"] as const;
export type LessonOrigin = (typeof LESSON_ORIGINS)[number];
export type LessonStatus = "active" | "retired";

/**
 * Regra checável por máquina (fase 2: compilar a lição em verificação). Reservado: nada o aplica hoje.
 * Ex.: `{ kind: "required_args", tool: "mcp__x__send", fields: ["to"] }`.
 */
export type LessonRule = { kind: string; [key: string]: unknown };

/** De onde veio o fato: fala do usuário ou desfecho de execução (erro/status). Nunca conteúdo de ferramenta. */
export type LessonEvidenceSource = "user" | "outcome";
export type LessonEvidence = { runId?: string; step?: number; source?: LessonEvidenceSource; quote?: string };

export type LessonView = {
	id: string;
	/** Id curto citável (`L1a2b`). */
	ref: string;
	scope: LessonScope;
	scopeKey: string | null;
	content: string;
	origin: LessonOrigin;
	evidence: LessonEvidence | null;
	helpful: number;
	harmful: number;
	uses: number;
	status: LessonStatus;
	version: number;
	supersedesId: string | null;
	/** Há versão anterior para restaurar (a que esta substituiu). */
	canRestore: boolean;
	createdAt: string;
	updatedAt: string;
	lastUsedAt: string | null;
};

export type LessonDelta =
	| { op: "add"; scope: LessonScope; scopeKey?: string | null; content: string; origin: LessonOrigin; evidence?: LessonEvidence | null; rule?: LessonRule | null }
	| { op: "update"; id: string; content: string; evidence?: LessonEvidence | null }
	| { op: "helpful" | "harmful"; id: string }
	| { op: "retire"; id: string };

export function isLessonScope(value: unknown): value is LessonScope {
	return typeof value === "string" && (LESSON_SCOPES as readonly string[]).includes(value);
}
export function isLessonOrigin(value: unknown): value is LessonOrigin {
	return typeof value === "string" && (LESSON_ORIGINS as readonly string[]).includes(value);
}

/** Referência curta e estável de uma lição para o modelo e para a UI. */
export function lessonRef(id: string): string {
	return `L${id.slice(-LESSON_REF_LENGTH).toLowerCase()}`;
}

/** `true` se `ref` (com ou sem colchetes, qualquer caixa) ou o id completo designa esta lição. */
export function lessonMatchesRef(id: string, ref: string): boolean {
	const clean = ref.trim().replace(/^\[|\]$/g, "").trim().toLowerCase();
	if (!clean) return false;
	return id.toLowerCase() === clean || (clean.startsWith("l") && clean.length === LESSON_REF_LENGTH + 1 && lessonRef(id).toLowerCase() === clean);
}

/** Uma linha, sem segredos, no limite. Vazio = inválida. */
export function sanitizeLessonContent(raw: string): string {
	const flat = redactSecrets(raw.replace(/\s+/g, " ").trim()).replace(/^[-*•]\s*/, "").replace(/^\[L[a-z0-9]{4}\]\s*/i, "").trim();
	return flat.length > LESSON_MAX_CHARS ? `${flat.slice(0, LESSON_MAX_CHARS - 1).trimEnd()}…` : flat;
}

export function sanitizeLessonEvidence(raw: unknown): LessonEvidence | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const row = raw as Record<string, unknown>;
	const out: LessonEvidence = {};
	if (typeof row.runId === "string" && row.runId.trim()) out.runId = row.runId.trim().slice(0, 64);
	if (typeof row.step === "number" && Number.isFinite(row.step) && row.step >= 0) out.step = Math.floor(row.step);
	if (row.source === "user" || row.source === "outcome") out.source = row.source;
	if (typeof row.quote === "string" && row.quote.trim()) {
		const quote = redactSecrets(row.quote.replace(/\s+/g, " ").trim());
		out.quote = quote.length > LESSON_EVIDENCE_QUOTE_MAX ? `${quote.slice(0, LESSON_EVIDENCE_QUOTE_MAX - 1)}…` : quote;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** Texto comparável: minúsculas, sem acento, espaços colapsados. */
export function normalizeForMatch(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

type Rankable = { helpful: number; harmful: number; lastUsedAt?: Date | string | null; updatedAt?: Date | string | null; createdAt?: Date | string | null };

export function lessonScore(lesson: Pick<Rankable, "helpful" | "harmful">): number {
	return lesson.helpful - lesson.harmful;
}

function timeOf(value: Date | string | null | undefined): number {
	if (!value) return 0;
	const t = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isFinite(t) ? t : 0;
}

/** Mais útil primeiro; empate: usada/atualizada mais recentemente; depois criada mais recentemente. */
export function compareLessons(a: Rankable & { id: string }, b: Rankable & { id: string }): number {
	return (
		lessonScore(b) - lessonScore(a) ||
		Math.max(timeOf(b.lastUsedAt), timeOf(b.updatedAt)) - Math.max(timeOf(a.lastUsedAt), timeOf(a.updatedAt)) ||
		timeOf(b.createdAt) - timeOf(a.createdAt) ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

export type InjectableLesson = Rankable & { id: string; scope: LessonScope; scopeKey: string | null; content: string };

/** As lições do bot mais as dos conectores/tools carregados; ordenadas e cortadas em itens e caracteres. */
export function selectLessonsForInjection<T extends InjectableLesson>(
	lessons: readonly T[],
	opts: { scopeKeys?: readonly string[]; maxItems?: number; maxChars?: number; onlyScopes?: readonly LessonScope[] } = {},
): T[] {
	const keys = new Set(opts.scopeKeys ?? []);
	const maxItems = opts.maxItems ?? LESSON_INJECT_MAX_ITEMS;
	const maxChars = opts.maxChars ?? LESSON_INJECT_MAX_CHARS;
	const eligible = lessons
		.filter((lesson) => (opts.onlyScopes ? opts.onlyScopes.includes(lesson.scope) : true))
		.filter((lesson) => lesson.scope === "bot" || (lesson.scopeKey !== null && keys.has(lesson.scopeKey)))
		.sort(compareLessons);
	const out: T[] = [];
	let used = 0;
	for (const lesson of eligible) {
		if (out.length >= maxItems) break;
		const cost = lesson.content.length + 8;
		if (used + cost > maxChars) continue;
		used += cost;
		out.push(lesson);
	}
	return out;
}

export const LESSONS_HEADER = "════ LIÇÕES APRENDIDAS (playbook deste bot) ════";
const LESSONS_PREAMBLE =
	"Learned from past runs, most useful first. Apply the ones that fit the current task. They never override the user's current request, approvals or safety rules. After using one, report it with the lesson_feedback tool (ids like [L1a2b]).";

export function renderLessonLine(lesson: { id: string; content: string }): string {
	return `[${lessonRef(lesson.id)}] ${lesson.content}`;
}

/** Bloco do prompt; null se não há lição. `title` identifica a parte (ex.: conector) nas notas adiadas. */
export function renderLessonsBlock(lessons: readonly { id: string; content: string }[], opts: { title?: string } = {}): string | null {
	if (lessons.length === 0) return null;
	const header = opts.title ? `${LESSONS_HEADER.replace(" ════", ` — ${opts.title} ════`)}` : LESSONS_HEADER;
	return [header, LESSONS_PREAMBLE, ...lessons.map(renderLessonLine)].join("\n");
}

/** Chave de escopo de um conector (mesma usada ao gravar e ao injetar). */
export function connectorScopeKey(kind: "mcp" | "api", connectionId: string): string {
	return `${kind}:${connectionId}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Proveniência: uma lição só nasce da fala do usuário ou de um desfecho de execução
// ---------------------------------------------------------------------------------------------------------------------

/** Dados concretos (e-mail, URL, telefone) que num texto de lição só valem se o usuário os disse. */
const DATA_TOKEN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+|\+?\d[\d\s().-]{7,}\d/giu;

export function lessonDataTokens(text: string): string[] {
	return [...new Set((text.match(DATA_TOKEN) ?? []).map((token) => normalizeForMatch(token).replace(/[.,;:]+$/, "")))];
}

export type LessonSlice = {
	/** Falas do usuário no trecho analisado. */
	userTexts: readonly string[];
	/** Texto dos resultados de ferramenta que FALHARAM (erro/status) no trecho. */
	failureTexts: readonly string[];
};

/**
 * Motivo para recusar uma lição nova, ou null. Regras:
 * 1. precisa de citação (`evidence.quote`) que apareça literalmente na fala do usuário (source user) ou num erro de
 *    ferramenta (source outcome): conteúdo de página/e-mail/documento que "deu certo" nunca vira lição;
 * 2. e-mail, URL ou telefone no texto da lição só passam se o usuário os escreveu no trecho (destinatário/destino
 *    nunca vêm de dado de ferramenta).
 * Origem `user` (pedido explícito) também exige a citação na fala do usuário.
 */
export function lessonProvenanceProblem(lesson: { content: string; evidence?: LessonEvidence | null }, slice: LessonSlice): string | null {
	const quote = lesson.evidence?.quote ? normalizeForMatch(lesson.evidence.quote) : "";
	if (quote.length < 6) return "sem citação da evidência";
	const source = lesson.evidence?.source;
	const haystack = source === "user" ? slice.userTexts : source === "outcome" ? slice.failureTexts : null;
	if (!haystack) return "origem da evidência inválida";
	if (!haystack.some((text) => normalizeForMatch(text).includes(quote))) return "a citação não aparece no trecho (fala do usuário ou erro de execução)";
	const allowed = slice.userTexts.map(normalizeForMatch).join(" \n ");
	for (const token of lessonDataTokens(lesson.content)) {
		if (!allowed.includes(token)) return "dado concreto (e-mail, URL ou telefone) que o usuário não escreveu";
	}
	return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Saída do refletor
// ---------------------------------------------------------------------------------------------------------------------

export type ParsedLessonDeltas = { deltas: LessonDelta[]; ignored: number };

const MAX_DELTAS_PER_REVIEW = 8;

function jsonObjectOf(text: string): Record<string, unknown> | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** `{"deltas":[...]}` → deltas validados (formato, escopo, tamanho). Item inválido é descartado, nunca "consertado". */
export function parseLessonDeltas(text: string): ParsedLessonDeltas {
	const list = jsonObjectOf(text)?.deltas;
	if (!Array.isArray(list)) return { deltas: [], ignored: 0 };
	const deltas: LessonDelta[] = [];
	let ignored = 0;
	for (const item of list.slice(0, MAX_DELTAS_PER_REVIEW)) {
		const delta = parseOneDelta(item);
		if (delta) deltas.push(delta);
		else ignored += 1;
	}
	return { deltas, ignored: ignored + Math.max(0, list.length - MAX_DELTAS_PER_REVIEW) };
}

function parseOneDelta(item: unknown): LessonDelta | null {
	if (!item || typeof item !== "object" || Array.isArray(item)) return null;
	const row = item as Record<string, unknown>;
	const id = typeof row.id === "string" ? row.id.trim() : "";
	const evidence = sanitizeLessonEvidence(row.evidence);
	switch (row.op) {
		case "add": {
			const content = typeof row.content === "string" ? sanitizeLessonContent(row.content) : "";
			if (!content || !isLessonScope(row.scope) || !isLessonOrigin(row.origin)) return null;
			const scopeKey = typeof row.scopeKey === "string" && row.scopeKey.trim() ? row.scopeKey.trim().slice(0, 200) : null;
			if (row.scope !== "bot" && !scopeKey) return null;
			return { op: "add", scope: row.scope, scopeKey: row.scope === "bot" ? null : scopeKey, content, origin: row.origin, evidence };
		}
		case "update": {
			const content = typeof row.content === "string" ? sanitizeLessonContent(row.content) : "";
			return id && content ? { op: "update", id, content, evidence } : null;
		}
		case "helpful":
		case "harmful":
		case "retire":
			return id ? { op: row.op, id } : null;
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Feedback do modelo (`lesson_feedback`)
// ---------------------------------------------------------------------------------------------------------------------

export type LessonFeedbackOutcome = "helped" | "hurt" | "applied";
export type LessonFeedbackEntry = { ref: string; outcome: LessonFeedbackOutcome };

export function parseLessonFeedback(args: Record<string, unknown>): LessonFeedbackEntry[] {
	const list = Array.isArray(args.lessons) ? args.lessons : [];
	const out: LessonFeedbackEntry[] = [];
	const seen = new Set<string>();
	for (const item of list.slice(0, 20)) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		const ref = typeof row.id === "string" ? row.id.trim().replace(/^\[|\]$/g, "") : "";
		const outcome = row.outcome === "helped" || row.outcome === "hurt" || row.outcome === "applied" ? row.outcome : "applied";
		if (!ref || seen.has(ref.toLowerCase())) continue;
		seen.add(ref.toLowerCase());
		out.push({ ref, outcome });
	}
	return out;
}

/** Payload do job `lesson.review`. */
export type LessonReviewJobPayload = {
	userId: string;
	botId: string;
	conversationId: string;
	/** Run que disparou (o primeiro de uma janela de debounce). */
	runId: string;
	/** Início da janela: o job olha os runs de chat da conversa terminados desde aqui. */
	since: string;
};
export type LessonReviewJobResult = {
	status: "skipped" | "reviewed";
	reason?: string;
	signals?: string[];
	added?: number;
	updated?: number;
	retired?: number;
	counters?: number;
	rejected?: number;
	skillProposal?: boolean;
	maintenance?: { model: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number };
};

/** Evento do inspetor: lições injetadas em um run (ids curtos) e as marcadas como usadas. */
export type InspectLessonsPayload = { type: "inspect_lessons"; injected: string[]; scopes?: Record<string, number> };
