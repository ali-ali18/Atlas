// E-mail do motor v4 (F7.1): triagem declarada pelo MODELO, rascunho e os dois cards persistidos.
//
// A decisão ("precisa de ação", "só pra saber", "ignorar") é um CAMPO que o modelo declara na tool `email_triage`; nada aqui
// lê o texto do e-mail para decidir. Este módulo só valida (enum, data, tamanhos) e deixa o cartão estável entre ao vivo e
// gravado. Puro: sem relógio próprio, sem rede, sem `crypto`.

export const EMAIL_SOURCES = ["gmail", "bot"] as const;
/** De onde vem o e-mail: o Gmail do dono (conector) ou a caixa própria do bot. */
export type EmailSourceId = (typeof EMAIL_SOURCES)[number];

export const EMAIL_TRIAGE_CATEGORIES = ["needs_action", "fyi", "ignore"] as const;
export type EmailTriageCategory = (typeof EMAIL_TRIAGE_CATEGORIES)[number];

export const EMAIL_TRIAGE_MAX_ITEMS = 30;
export const EMAIL_TRIAGE_ID_MAX = 200;
export const EMAIL_TRIAGE_SUMMARY_MAX = 240;
export const EMAIL_TRIAGE_REQUESTER_MAX = 120;
export const EMAIL_TRIAGE_FIELD_MAX = 200;

export const EMAIL_DRAFT_RECIPIENTS_MAX = 10;
export const EMAIL_DRAFT_SUBJECT_MAX = 300;
export const EMAIL_DRAFT_BODY_MAX = 20_000;
export const EMAIL_ADDRESS_MAX = 254;

export function isEmailSourceId(value: unknown): value is EmailSourceId {
	return typeof value === "string" && (EMAIL_SOURCES as readonly string[]).includes(value);
}

export function isEmailTriageCategory(value: unknown): value is EmailTriageCategory {
	return typeof value === "string" && (EMAIL_TRIAGE_CATEGORIES as readonly string[]).includes(value);
}

export type EmailTriageEntry = {
	/** Identificador que `email_list` devolveu (o que `email_read` aceita). */
	id: string;
	source?: EmailSourceId;
	category: EmailTriageCategory;
	/** Uma frase: o que a mensagem pede ou informa. */
	summary: string;
	from?: string;
	subject?: string;
	/** Quem pede a ação (nome ou endereço), quando difere do remetente ou quando é claro. */
	requester?: string;
	/** `YYYY-MM-DD` (dia) ou data e hora ISO 8601 com fuso. */
	deadline?: string;
};

const oneLine = (value: unknown, max: number): string | undefined => {
	if (typeof value !== "string") return undefined;
	const text = value.split(/\s+/).filter(Boolean).join(" ").trim();
	return text ? text.slice(0, max) : undefined;
};

/**
 * Prazo válido: `YYYY-MM-DD` real (rejeita 30/02) ou ISO 8601 com fuso explícito (`Z` ou `+hh:mm`). Sem fuso o instante
 * seria ambíguo, então falha com a dica. Devolve o valor normalizado ou `null`.
 */
export function normalizeEmailDeadline(value: unknown): string | null {
	const raw = typeof value === "string" ? value.trim() : "";
	if (raw.length < 10 || raw.length > 40) return null;
	if (raw[4] !== "-" || raw[7] !== "-") return null;
	if (raw.length === 10) {
		const parsed = new Date(`${raw}T00:00:00Z`);
		return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw ? raw : null;
	}
	if (raw[10] !== "T") return null;
	const hasZone = raw.endsWith("Z") || ((raw[raw.length - 6] === "+" || raw[raw.length - 6] === "-") && raw[raw.length - 3] === ":");
	if (!hasZone) return null;
	const parsed = new Date(raw);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** Instante do prazo para ordenar e para marcar vencido (dia sem hora = fim do dia UTC). */
export function emailDeadlineTime(deadline: string): number {
	return new Date(deadline.length === 10 ? `${deadline}T23:59:59Z` : deadline).getTime();
}

export type EmailTriageParse = { ok: true; items: EmailTriageEntry[] } | { ok: false; error: string };

const TRIAGE_FIELDS: readonly string[] = ["id", "source", "category", "summary", "from", "subject", "requester", "deadline"];

/**
 * Valida a triagem declarada pelo modelo. Campo desconhecido, categoria fora do enum, prazo inválido, texto vazio ou longo
 * demais e id repetido FALHAM com a lista do que é aceito (nunca descarta em silêncio).
 */
export function normalizeEmailTriage(raw: unknown): EmailTriageParse {
	if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "items must be a non-empty list. Hint: one entry per message, each with id, category and summary." };
	if (raw.length > EMAIL_TRIAGE_MAX_ITEMS) return { ok: false, error: `At most ${EMAIL_TRIAGE_MAX_ITEMS} messages per triage (got ${raw.length}). Hint: send the most relevant ones first.` };
	const items: EmailTriageEntry[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of raw.entries()) {
		const where = `items[${index}]`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { ok: false, error: `${where} must be an object with ${TRIAGE_FIELDS.join(", ")}.` };
		const row = entry as Record<string, unknown>;
		const unknown = Object.keys(row).filter((key) => !TRIAGE_FIELDS.includes(key));
		if (unknown.length > 0) return { ok: false, error: `${where}: unknown field(s) ${unknown.join(", ")}. Accepted: ${TRIAGE_FIELDS.join(", ")}.` };
		const id = oneLine(row.id, EMAIL_TRIAGE_ID_MAX);
		if (!id) return { ok: false, error: `${where}.id is required (the id email_list returned).` };
		if (seen.has(id)) return { ok: false, error: `${where}.id "${id}" appears twice. Hint: one entry per message.` };
		seen.add(id);
		if (!isEmailTriageCategory(row.category)) return { ok: false, error: `${where}.category must be one of: ${EMAIL_TRIAGE_CATEGORIES.join(", ")}.` };
		const summary = oneLine(row.summary, EMAIL_TRIAGE_SUMMARY_MAX + 1);
		if (!summary) return { ok: false, error: `${where}.summary is required: one short sentence (at most ${EMAIL_TRIAGE_SUMMARY_MAX} characters).` };
		if (summary.length > EMAIL_TRIAGE_SUMMARY_MAX) return { ok: false, error: `${where}.summary is too long (at most ${EMAIL_TRIAGE_SUMMARY_MAX} characters). Hint: say only what it asks or informs.` };
		if (row.source !== undefined && !isEmailSourceId(row.source)) return { ok: false, error: `${where}.source must be one of: ${EMAIL_SOURCES.join(", ")}.` };
		let deadline: string | undefined;
		if (row.deadline !== undefined) {
			const normalized = normalizeEmailDeadline(row.deadline);
			if (!normalized) return { ok: false, error: `${where}.deadline "${String(row.deadline).slice(0, 50)}" is not a valid date. Hint: use YYYY-MM-DD, or ISO 8601 with a time zone (2026-11-12T17:00:00-03:00). Leave it out when the message gives no deadline.` };
			deadline = normalized;
		}
		const requester = oneLine(row.requester, EMAIL_TRIAGE_REQUESTER_MAX + 1);
		if (requester && requester.length > EMAIL_TRIAGE_REQUESTER_MAX) return { ok: false, error: `${where}.requester is too long (at most ${EMAIL_TRIAGE_REQUESTER_MAX} characters).` };
		const from = oneLine(row.from, EMAIL_TRIAGE_FIELD_MAX);
		const subject = oneLine(row.subject, EMAIL_TRIAGE_FIELD_MAX);
		items.push({
			id,
			category: row.category,
			summary,
			...(row.source !== undefined && { source: row.source as EmailSourceId }),
			...(from && { from }),
			...(subject && { subject }),
			...(requester && { requester }),
			...(deadline && { deadline }),
		});
	}
	return { ok: true, items };
}

/** Ordem do cartão: grupos na ordem do enum; dentro do grupo, prazo mais próximo primeiro e sem prazo por último. */
export function sortEmailTriage(items: readonly EmailTriageEntry[]): EmailTriageEntry[] {
	const rank = (category: EmailTriageCategory) => EMAIL_TRIAGE_CATEGORIES.indexOf(category);
	return items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => {
			if (a.item.category !== b.item.category) return rank(a.item.category) - rank(b.item.category);
			const ta = a.item.deadline ? emailDeadlineTime(a.item.deadline) : Number.POSITIVE_INFINITY;
			const tb = b.item.deadline ? emailDeadlineTime(b.item.deadline) : Number.POSITIVE_INFINITY;
			return ta === tb ? a.index - b.index : ta - tb;
		})
		.map(({ item }) => item);
}

/** Quantos há em cada categoria (o cartão e o resumo da tool usam). */
export function countEmailTriage(items: readonly EmailTriageEntry[]): Record<EmailTriageCategory, number> {
	const counts: Record<EmailTriageCategory, number> = { needs_action: 0, fyi: 0, ignore: 0 };
	for (const item of items) counts[item.category] += 1;
	return counts;
}

/** Hash FNV-1a curto e determinístico (puro; sem `crypto`). */
function fnv(value: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * Identidade do cartão de triagem: o mesmo run com o mesmo conteúdo é o mesmo cartão (retomada não duplica). Entra tudo o que o
 * cartão mostra (resumo, quem pede, remetente, assunto, prazo): a triagem corrigida de uma mensagem é outro cartão, não o antigo.
 * JSON evita colisão entre campos (um `|` dentro do resumo não emenda com o campo seguinte).
 */
export function emailTriageCardId(runId: string, items: readonly EmailTriageEntry[]): string {
	return `${runId}:email-triage:${fnv(items.map((item) => JSON.stringify([item.source ?? "", item.id, item.category, item.deadline ?? "", item.summary, item.requester ?? "", item.from ?? "", item.subject ?? ""])).sort().join("\n"))}`;
}

/** Identidade do cartão de rascunho: o mesmo conteúdo no mesmo run é o mesmo cartão; texto, cópia, resposta ou guardado novos são outro rascunho. */
export function emailDraftCardId(runId: string, draft: { source: EmailSourceId; to: readonly string[]; cc?: readonly string[]; subject: string; body: string; reply?: boolean; saved?: boolean }): string {
	return `${runId}:email-draft:${fnv(JSON.stringify([draft.source, [...draft.to], [...(draft.cc ?? [])], draft.subject, draft.body, draft.reply === true, draft.saved === true]))}`;
}

export type PersistedEmailTriageCard = {
	v: 1;
	kind: "email-triage";
	/** Estável entre ao vivo e gravado. */
	cardId: string;
	runId?: string;
	items: EmailTriageEntry[];
};

export type PersistedEmailDraftCard = {
	v: 1;
	kind: "email-draft";
	cardId: string;
	runId?: string;
	source: EmailSourceId;
	to: string[];
	cc?: string[];
	subject: string;
	body: string;
	/** É resposta a uma mensagem recebida. */
	reply?: boolean;
	/** O rascunho foi guardado na caixa do dono (Gmail). Falso = só existe neste cartão. */
	saved: boolean;
};

/** Endereço de e-mail com formato mínimo (um `@`, sem espaço nem quebra de linha): impede injetar cabeçalho. */
export function isPlausibleEmailAddress(value: unknown): value is string {
	if (typeof value !== "string" || value.length > EMAIL_ADDRESS_MAX || value.length < 3) return false;
	for (const ch of value) if (ch === " " || ch === "\r" || ch === "\n" || ch === "\t" || ch === "<" || ch === ">" || ch === "," || ch === ";" || ch === '"') return false;
	const at = value.indexOf("@");
	return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1 && value.indexOf(".", at) > at + 1 && !value.endsWith(".");
}

/** Revalida o cartão gravado: nunca confia no JSON do banco. */
export function parseEmailTriageCard(row: Record<string, unknown>): PersistedEmailTriageCard | null {
	const cardId = oneLine(row.cardId, 200);
	if (!cardId) return null;
	const parsed = normalizeEmailTriage(row.items);
	if (!parsed.ok) return null;
	const runId = oneLine(row.runId, 160);
	return { v: 1, kind: "email-triage", cardId, ...(runId && { runId }), items: parsed.items };
}

export function parseEmailDraftCard(row: Record<string, unknown>): PersistedEmailDraftCard | null {
	const cardId = oneLine(row.cardId, 200);
	if (!cardId || !isEmailSourceId(row.source)) return null;
	const to = Array.isArray(row.to) ? row.to.filter(isPlausibleEmailAddress).slice(0, EMAIL_DRAFT_RECIPIENTS_MAX) : [];
	if (to.length === 0) return null;
	const cc = Array.isArray(row.cc) ? row.cc.filter(isPlausibleEmailAddress).slice(0, EMAIL_DRAFT_RECIPIENTS_MAX) : [];
	const subject = oneLine(row.subject, EMAIL_DRAFT_SUBJECT_MAX) ?? "";
	const body = typeof row.body === "string" ? row.body.slice(0, EMAIL_DRAFT_BODY_MAX) : "";
	if (!body.trim()) return null;
	const runId = oneLine(row.runId, 160);
	return {
		v: 1,
		kind: "email-draft",
		cardId,
		...(runId && { runId }),
		source: row.source,
		to,
		...(cc.length > 0 && { cc }),
		subject,
		body,
		...(row.reply === true && { reply: true }),
		saved: row.saved === true,
	};
}
