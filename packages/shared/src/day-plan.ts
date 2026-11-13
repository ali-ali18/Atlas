// Plano do dia (F7.2): o cartão `day-plan` que o `brief` da agenda entrega. UMA mensagem por dia, com seções
// (compromissos, e-mails que pedem ação, pendências, entregas). Funções PURAS.
//
// Honestidade por estrutura: seção vazia some; fonte que falhou NÃO vira texto do modelo, vira `sourceErrors` (campo
// declarado pelo coletor), e a UI escreve a linha ("não consegui ler a agenda") no idioma do dono. O modelo escreve só
// os itens e a frase de abertura.
import { isValidTimeZone } from "./proactive.js";

export const DAY_PLAN_SECTION_IDS = ["commitments", "emails", "pending", "deliveries"] as const;
export type DayPlanSectionId = (typeof DAY_PLAN_SECTION_IDS)[number];

/** Fontes que o brief lê. `email` é opcional (outra frente) e `notebook` entra como pendência fixada. */
export const DAY_PLAN_SOURCES = ["calendar", "email", "agenda", "notebook", "purchases", "tasks"] as const;
export type DayPlanSource = (typeof DAY_PLAN_SOURCES)[number];

/** `failed` = a leitura deu erro; `needs_connection` = o app precisa ser conectado de novo (login expirou). */
export const DAY_PLAN_ERROR_REASONS = ["failed", "needs_connection"] as const;
export type DayPlanErrorReason = (typeof DAY_PLAN_ERROR_REASONS)[number];

export type DayPlanSourceError = { source: DayPlanSource; reason: DayPlanErrorReason };

export type DayPlanItem = {
	text: string;
	/** Hora ("09:00") ou "o dia todo": rótulo curto, só de compromisso. */
	time?: string;
	/** Uma linha de apoio: por que importa, quem pede, prazo. */
	detail?: string;
};

export type DayPlanSection = { id: DayPlanSectionId; items: DayPlanItem[] };

export const DAY_PLAN_HEADLINE_MAX = 240;
export const DAY_PLAN_ITEM_TEXT_MAX = 200;
export const DAY_PLAN_ITEM_DETAIL_MAX = 240;
export const DAY_PLAN_TIME_MAX = 24;
/** Itens por seção: o plano é uma olhada, não uma lista sem fim. */
export const DAY_PLAN_ITEMS_PER_SECTION = 8;

export type PersistedDayPlanCard = {
	v: 1;
	kind: "day-plan";
	/** Identidade do cartão: um por run do brief (retomada não duplica). */
	planId: string;
	runId?: string;
	/** Dia do plano, "AAAA-MM-DD" no fuso do dono. */
	date: string;
	timeZone: string;
	headline: string;
	sections: DayPlanSection[];
	sourceErrors: DayPlanSourceError[];
};

const oneLine = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : undefined);

function parseItems(raw: unknown, allowTime: boolean): DayPlanItem[] | null {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) return null;
	const items: DayPlanItem[] = [];
	for (const entry of raw.slice(0, DAY_PLAN_ITEMS_PER_SECTION)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
		const r = entry as Record<string, unknown>;
		const text = oneLine(r.text, DAY_PLAN_ITEM_TEXT_MAX);
		if (!text) return null;
		const detail = oneLine(r.detail, DAY_PLAN_ITEM_DETAIL_MAX);
		const time = allowTime ? oneLine(r.time, DAY_PLAN_TIME_MAX) : undefined;
		items.push({ text, ...(time && { time }), ...(detail && { detail }) });
	}
	return items;
}

export type DayPlanInput = {
	headline: unknown;
	commitments?: unknown;
	emails?: unknown;
	pending?: unknown;
	deliveries?: unknown;
};

export type BuildDayPlanResult = { ok: true; sections: DayPlanSection[]; headline: string } | { ok: false; error: string };

/**
 * Valida o que o modelo escreveu e monta as seções NA ORDEM FIXA, descartando as vazias (nunca "nada por enquanto").
 * Lista longa demais é recusada com o limite (tool honesta), não cortada em silêncio.
 */
export function buildDayPlanSections(input: DayPlanInput): BuildDayPlanResult {
	const headline = oneLine(input.headline, DAY_PLAN_HEADLINE_MAX);
	if (!headline) return { ok: false, error: "headline is required: one sentence summarizing the day." };
	const named: Array<[DayPlanSectionId, unknown, boolean]> = [
		["commitments", input.commitments, true],
		["emails", input.emails, false],
		["pending", input.pending, false],
		["deliveries", input.deliveries, false],
	];
	const sections: DayPlanSection[] = [];
	for (const [id, raw, allowTime] of named) {
		if (Array.isArray(raw) && raw.length > DAY_PLAN_ITEMS_PER_SECTION) return { ok: false, error: `${id} has ${raw.length} items; the limit is ${DAY_PLAN_ITEMS_PER_SECTION}. Keep the most important.` };
		const items = parseItems(raw, allowTime);
		if (items === null) return { ok: false, error: `${id} must be a list of { text${allowTime ? ", time" : ""}, detail } with a non-empty text.` };
		if (items.length > 0) sections.push({ id, items });
	}
	return { ok: true, sections, headline };
}

export function parseDayPlanCard(row: Record<string, unknown>): PersistedDayPlanCard | null {
	const planId = oneLine(row.planId, 200);
	const date = typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : null;
	const timeZone = typeof row.timeZone === "string" && isValidTimeZone(row.timeZone) ? row.timeZone : null;
	const headline = oneLine(row.headline, DAY_PLAN_HEADLINE_MAX);
	if (!planId || !date || !timeZone || !headline || !Array.isArray(row.sections)) return null;
	const sections: DayPlanSection[] = [];
	for (const raw of row.sections) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const r = raw as Record<string, unknown>;
		const id = (DAY_PLAN_SECTION_IDS as readonly unknown[]).includes(r.id) ? (r.id as DayPlanSectionId) : null;
		const items = parseItems(r.items, id === "commitments");
		if (!id || !items) return null;
		if (items.length > 0 && !sections.some((s) => s.id === id)) sections.push({ id, items });
	}
	const sourceErrors: DayPlanSourceError[] = [];
	if (Array.isArray(row.sourceErrors)) {
		for (const raw of row.sourceErrors) {
			const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
			const source = r && (DAY_PLAN_SOURCES as readonly unknown[]).includes(r.source) ? (r.source as DayPlanSource) : null;
			const reason = r && (DAY_PLAN_ERROR_REASONS as readonly unknown[]).includes(r.reason) ? (r.reason as DayPlanErrorReason) : null;
			if (source && reason && !sourceErrors.some((e) => e.source === source)) sourceErrors.push({ source, reason });
		}
	}
	const runId = oneLine(row.runId, 160);
	return { v: 1, kind: "day-plan", planId, ...(runId && { runId }), date, timeZone, headline, sections, sourceErrors };
}
