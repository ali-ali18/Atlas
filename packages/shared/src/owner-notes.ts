/**
 * Caderno do dono (Motor v4, F5.1): notas duráveis que o dono (ou o bot, a pedido dele, ou o sono) guarda além do
 * caderno de trabalho de um run. Funções puras (sem I/O): limites, validação, dedupe, busca e o trecho do `[context]`.
 *
 * Escopo: `botId` nulo = do dono (todos os bots leem); `botId` preenchido = só deste bot. O db filtra pelo dono em
 * toda consulta; aqui não há dado de ninguém.
 */
import { z } from "zod";
import { normalizeForDedupe } from "./proactive.js";

export const OWNER_NOTE_TITLE_MAX_CHARS = 120;
/** Limite técnico do corpo de UMA nota (a janela de leitura do modelo é maior; textos longos viram arquivo, não nota). */
export const OWNER_NOTE_BODY_MAX_CHARS = 20_000;
/**
 * Limite técnico por dono. A busca varre o caderno inteiro (sem índice de texto), então o teto garante que nenhuma nota
 * fica de fora dela: 500 notas, no pior caso ~10 MB lidos por busca.
 */
export const OWNER_NOTES_MAX_PER_OWNER = 500;
/** Pior caso de um corpo de nota devolvido a uma tool de uma vez: o resto vem em páginas (`note_get` com offset). */
export const OWNER_NOTE_PAGE_CHARS = 8_000;
/** Teto TÉCNICO do `[context]`: quantos títulos fixados entram e o tamanho do trecho. O resto fica a uma busca de distância. */
export const OWNER_NOTES_PINNED_CONTEXT_MAX = 20;
export const OWNER_NOTES_PINNED_CONTEXT_MAX_CHARS = 1_800;
export const OWNER_NOTES_SEARCH_DEFAULT_LIMIT = 8;
export const OWNER_NOTES_SEARCH_MAX_LIMIT = 20;
/** Trecho de corpo mostrado por resultado de busca. */
export const OWNER_NOTE_SNIPPET_CHARS = 240;

export const OWNER_NOTE_SOURCES = ["owner", "agent", "sleep"] as const;
export type OwnerNoteSource = (typeof OWNER_NOTE_SOURCES)[number];

export type OwnerNoteView = {
	id: string;
	/** Nulo = nota do dono (vale para todos os bots). */
	botId: string | null;
	title: string;
	body: string;
	pinned: boolean;
	source: OwnerNoteSource;
	createdAt: string;
	updatedAt: string;
};

/** Texto para comparar notas: sem acento, caixa ou pontuação. Dois textos com a mesma chave são a mesma nota. */
export function noteDedupeKey(text: string): string {
	return normalizeForDedupe(text);
}

/** A nota repete outra do mesmo escopo? Igualdade normalizada do corpo (não há embedding para notas; ver ADR/feature). */
export function findDuplicateNote<T extends { id: string; body: string; botId: string | null }>(existing: readonly T[], candidate: { body: string; botId: string | null }, ignoreId?: string): T | null {
	const key = noteDedupeKey(candidate.body);
	if (key.length === 0) return null;
	return existing.find((note) => note.id !== ignoreId && note.botId === candidate.botId && noteDedupeKey(note.body) === key) ?? null;
}

const titleField = z.string().trim().min(1, "Dê um título à nota.").max(OWNER_NOTE_TITLE_MAX_CHARS, `O título pode ter até ${OWNER_NOTE_TITLE_MAX_CHARS} caracteres.`);
const bodyField = z.string().max(OWNER_NOTE_BODY_MAX_CHARS, `A nota pode ter até ${OWNER_NOTE_BODY_MAX_CHARS} caracteres.`).refine((value) => value.trim().length > 0, "Escreva o texto da nota.");
const botIdField = z.string().trim().min(1).max(64).nullable();

/** Corpo de `POST /v1/notes`. Campo desconhecido é erro (nada de descartar em silêncio). */
export const createOwnerNoteSchema = z.strictObject({ title: titleField, body: bodyField, pinned: z.boolean().optional(), botId: botIdField.optional() });
/** Corpo de `PATCH /v1/notes/:id`: ao menos um campo. O escopo (`botId`) não muda depois de criada. */
export const updateOwnerNoteSchema = z
	.strictObject({ title: titleField.optional(), body: bodyField.optional(), pinned: z.boolean().optional() })
	.refine((value) => Object.keys(value).length > 0, "Informe o que mudar: título, texto ou fixada.");

export type CreateOwnerNoteInput = z.infer<typeof createOwnerNoteSchema>;
export type UpdateOwnerNoteInput = z.infer<typeof updateOwnerNoteSchema>;

export type OwnerNoteParse<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): OwnerNoteParse<T> {
	const parsed = schema.safeParse(raw);
	if (parsed.success) return { ok: true, value: parsed.data };
	const issue = parsed.error.issues[0];
	if (issue?.code === "unrecognized_keys") return { ok: false, error: `Campo desconhecido: ${issue.keys.join(", ")}.` };
	return { ok: false, error: issue?.message ?? "Pedido inválido." };
}

export const parseCreateOwnerNote = (raw: unknown): OwnerNoteParse<CreateOwnerNoteInput> => parseWith(createOwnerNoteSchema, raw);
export const parseUpdateOwnerNote = (raw: unknown): OwnerNoteParse<UpdateOwnerNoteInput> => parseWith(updateOwnerNoteSchema, raw);

const tokensOf = (text: string): string[] => [...new Set(noteDedupeKey(text).split(" ").filter((token) => token.length > 1))];

export type RankableNote = { id: string; title: string; body: string; pinned: boolean; updatedAt: Date | string };

/**
 * Busca no caderno: cada palavra da consulta pontua (título vale 3, texto 1; palavra inteira vale mais que pedaço);
 * nota fixada desempata. Sem consulta, as mais recentes. Determinístico, sem I/O.
 */
export function rankNotes<T extends RankableNote>(notes: readonly T[], query: string, limit = OWNER_NOTES_SEARCH_DEFAULT_LIMIT): T[] {
	const max = Math.min(Math.max(1, Math.floor(limit)), OWNER_NOTES_SEARCH_MAX_LIMIT);
	const time = (note: T) => new Date(note.updatedAt).getTime();
	const byRecency = (a: T, b: T) => time(b) - time(a) || a.id.localeCompare(b.id);
	const terms = tokensOf(query);
	if (terms.length === 0) return [...notes].sort(byRecency).slice(0, max);
	const scored: Array<{ note: T; score: number }> = [];
	for (const note of notes) {
		const title = ` ${noteDedupeKey(note.title)} `;
		const body = ` ${noteDedupeKey(note.body)} `;
		let score = 0;
		for (const term of terms) {
			if (title.includes(` ${term} `)) score += 3;
			else if (title.includes(term)) score += 1.5;
			if (body.includes(` ${term} `)) score += 1;
			else if (body.includes(term)) score += 0.5;
		}
		if (score > 0) scored.push({ note, score: score + (note.pinned ? 0.25 : 0) });
	}
	return scored.sort((a, b) => b.score - a.score || byRecency(a.note, b.note)).slice(0, max).map((entry) => entry.note);
}

/** Primeiras palavras do corpo, numa linha, para resultado de busca. */
export function noteSnippet(body: string, max = OWNER_NOTE_SNIPPET_CHARS): string {
	const flat = body.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Trecho do `[context]` com os títulos das notas fixadas (texto para o MODELO: inglês curto). Entra só o título e o id;
 * o corpo se lê sob demanda. Teto técnico: `OWNER_NOTES_PINNED_CONTEXT_MAX` títulos e `…_MAX_CHARS` caracteres; o que
 * passar disso vira "+N" e fica a uma busca de distância. Sem nota fixada, nenhum trecho (o prompt não cresce).
 */
export function renderPinnedNotesContext(pinned: readonly Pick<OwnerNoteView, "id" | "title">[]): string | null {
	if (pinned.length === 0) return null;
	const head = "Pinned notebook notes (titles only; read one with note_get, find others with note_search):";
	const lines: string[] = [];
	let used = head.length;
	for (const note of pinned) {
		if (lines.length >= OWNER_NOTES_PINNED_CONTEXT_MAX) break;
		const line = `- [${note.id}] ${note.title.replace(/\s+/g, " ").trim()}`;
		if (used + line.length + 1 > OWNER_NOTES_PINNED_CONTEXT_MAX_CHARS) break;
		lines.push(line);
		used += line.length + 1;
	}
	const rest = pinned.length - lines.length;
	return [head, ...lines, ...(rest > 0 ? [`(+${rest} more pinned notes: use note_search)`] : [])].join("\n");
}
