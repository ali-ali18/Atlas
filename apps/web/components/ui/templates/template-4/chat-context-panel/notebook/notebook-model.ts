import {
	EFFECT_CLASSES,
	OWNER_NOTE_BODY_MAX_CHARS,
	OWNER_NOTE_TITLE_MAX_CHARS,
	OWNER_NOTES_MAX_PER_OWNER,
	type DoctorFinding,
	type EffectClass,
	type LearnedRuleView,
	type MemoryChange,
	type OwnerNoteView,
	type SleepReportView,
	type SleepStoredProposal,
} from "@workspace/shared";
import { AtlasApiError, apiErrorCode } from "@/lib/atlas-api";
import { formatDate } from "@/lib/format";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { memoryRelativeDate } from "../memory-tab-helpers";

/** Texto do caderno e das regras para o dono: puro, sem I/O. O relógio e o idioma entram por parâmetro. */

export type NoteFilter = "bot" | "all";

/** Fixadas primeiro; dentro de cada grupo, a mais recente no topo. Não muda a lista recebida. */
export function sortNotes(notes: readonly OwnerNoteView[]): OwnerNoteView[] {
	return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

/** "Você", "O bot" ou "Aprendido à noite". */
export function noteOriginLabel(source: OwnerNoteView["source"], { t }: Translator = defaultTranslator): string {
	return t(`notebook.notes.origin.${source}`);
}

/** Onde a nota vale: todos os bots, só este ou só outro (na visão "Todas"). */
export function noteScopeLabel(note: Pick<OwnerNoteView, "botId">, botId: string, { t }: Translator = defaultTranslator): string {
	if (note.botId === null) return t("notebook.notes.scope.all");
	return note.botId === botId ? t("notebook.notes.scope.bot") : t("notebook.notes.scope.other");
}

/** Linha de meta da nota: "Você · Vale para todos os bots · há 2 h". */
export function noteMeta(note: OwnerNoteView, botId: string, now: Date, translator: Translator = defaultTranslator): string {
	return [noteOriginLabel(note.source, translator), noteScopeLabel(note, botId, translator), memoryRelativeDate(note.updatedAt, now, undefined, translator.locale)].filter(Boolean).join(" · ");
}

export type NoteDraft = { title: string; body: string };

/** Validação antes de ir ao servidor (os mesmos limites do `shared`), com a frase pronta. `null` = pode enviar. */
export function validateNoteDraft(draft: NoteDraft, { t }: Translator = defaultTranslator): string | null {
	const title = draft.title.trim();
	if (title.length === 0) return t("notebook.notes.error.titleEmpty");
	if (title.length > OWNER_NOTE_TITLE_MAX_CHARS) return t("notebook.notes.error.titleLong", { max: OWNER_NOTE_TITLE_MAX_CHARS });
	if (draft.body.trim().length === 0) return t("notebook.notes.error.bodyEmpty");
	if (draft.body.length > OWNER_NOTE_BODY_MAX_CHARS) return t("notebook.notes.error.bodyLong", { max: OWNER_NOTE_BODY_MAX_CHARS });
	return null;
}

/** Erro de criar/editar/fixar nota em frase simples (409 limit|duplicate|conflict, 404). Nunca mostra código nem status. */
export function noteErrorMessage(error: unknown, { t }: Translator = defaultTranslator): string {
	if (error instanceof AtlasApiError) {
		const code = apiErrorCode(error);
		if (error.status === 409 && code === "limit") return t("notebook.notes.error.limit", { max: OWNER_NOTES_MAX_PER_OWNER });
		if (error.status === 409 && code === "duplicate") return t("notebook.notes.error.duplicate");
		if (error.status === 409) return t("notebook.notes.error.conflict");
		if (error.status === 404) return t("notebook.notes.error.notFound");
	}
	return t("notebook.notes.error.generic");
}

/** "o bot for enviar mensagens": o efeito da regra em palavras. Efeito ausente ou desconhecido = qualquer ação. */
export function ruleEffectPhrase(effect: LearnedRuleView["effect"], { t }: Translator = defaultTranslator): string {
	return effect && (EFFECT_CLASSES as readonly string[]).includes(effect) ? t(`notebook.rules.effect.${effect as EffectClass}`) : t("notebook.rules.effect.any");
}

/** Primeira letra maiúscula, para a frase virar título da linha. */
export const capitalize = (text: string): string => (text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text);

/**
 * Alvos de regra que sabemos dizer em frase de produto. A chave é o nome interno da ação normalizado (minúsculo, sem
 * prefixo `mcp__` nem `google_`); o valor é o sufixo da mensagem `notebook.rules.target.*`. Nome fora do mapa não
 * aparece: a linha já diz a classe ("Quando o bot for ler informações") e o usuário nunca vê nome interno.
 */
const RULE_TARGETS = {
	gmail_send_email: "gmailSend",
	gmail_send_message: "gmailSend",
	gmail_create_draft: "gmailDraft",
	gmail_search_messages: "gmailRead",
	gmail_search_threads: "gmailRead",
	gmail_read_message: "gmailRead",
	gmail_read_thread: "gmailRead",
	gmail_get_message: "gmailRead",
	gmail_get_thread: "gmailRead",
	drive_list_files: "driveList",
	drive_list_recent_files: "driveList",
	drive_search_files: "driveSearch",
	drive_read_file_content: "driveRead",
	drive_get_file_content: "driveRead",
	drive_create_file: "driveCreate",
	calendar_list_events: "calendarList",
	calendar_create_event: "calendarCreate",
	github_create_issue: "githubIssue",
	github_create_pull_request: "githubPullRequest",
} as const satisfies Record<string, string>;

const normalizeRuleMatch = (match: string): string =>
	match
		.trim()
		.toLowerCase()
		.replace(/^mcp__/, "")
		.replace(/__+/g, "_")
		.replace(/^google_/, "");

/** O alvo da regra em frase ("listar arquivos do Drive"). `*`, vazio ou ação que não sabemos dizer = nada (a classe já explica). */
export function ruleMatchLabel(match: string, { t }: Translator = defaultTranslator): string | null {
	const target = (RULE_TARGETS as Record<string, string | undefined>)[normalizeRuleMatch(match)];
	return target ? t("notebook.rules.onlyFor", { match: t(`notebook.rules.target.${target as (typeof RULE_TARGETS)[keyof typeof RULE_TARGETS]}`) }) : null;
}

export function ruleVerdictLabel(verdict: LearnedRuleView["verdict"], { t }: Translator = defaultTranslator): string {
	return t(`notebook.rules.verdict.${verdict}`);
}

/** "Você definiu · há 3 dias" / "O bot aprendeu". */
export function ruleSourceLabel(rule: Pick<LearnedRuleView, "source" | "learnedAt">, now: Date, translator: Translator = defaultTranslator): string {
	const source = translator.t(`notebook.rules.source.${rule.source}`);
	const when = rule.learnedAt ? memoryRelativeDate(rule.learnedAt, now, undefined, translator.locale) : "";
	return when ? translator.t("notebook.rules.learnedAt", { source, when }) : source;
}

/** Erro de editar/apagar regra: 422 (acima do teto), 409 (mudou), 404. */
export function ruleErrorMessage(error: unknown, { t }: Translator = defaultTranslator): string {
	if (error instanceof AtlasApiError) {
		if (error.status === 422) return t("notebook.rules.error.ceiling");
		if (error.status === 409) return t("notebook.rules.error.conflict");
		if (error.status === 404) return t("notebook.rules.error.notFound");
	}
	return t("notebook.rules.error.generic");
}

/** Data do relatório (`YYYY-MM-DD`, dia local do dono) como "7 de nov." sem passar por fuso. */
export function reportDateLabel(slot: string, locale: Translator["locale"]): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slot);
	if (!match) return slot;
	return formatDate(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)), locale, { day: "numeric", month: "short", timeZone: "UTC" });
}

export function reportTitle(report: Pick<SleepReportView, "kind" | "slot">, { t, locale }: Translator = defaultTranslator): string {
	const date = reportDateLabel(report.slot, locale);
	return report.kind === "doctor" ? t("notebook.review.doctor", { date }) : t("notebook.review.daily", { date });
}

/** Resumo em frase: o do servidor quando houver; senão uma frase pelo estado do relatório. */
export function reportSummary(report: Pick<SleepReportView, "status" | "summary">, { t }: Translator = defaultTranslator): string {
	const text = report.summary?.trim();
	if (text) return text;
	return t(`notebook.review.summaryFallback.${report.status}`);
}

export const openProposals = (report: Pick<SleepReportView, "proposals">): SleepStoredProposal[] => report.proposals.filter((proposal) => proposal.status === "open");

const SNIPPET_CHARS = 140;
const snippet = (text: string | null | undefined): string => {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
};

/** O que a mudança fez, em frase ("Guardou a nota “Roteiro”", "Apagou: prefere café"). */
export function changePhrase(change: Pick<MemoryChange, "target" | "action" | "before" | "after" | "beforeNote" | "afterNote">, { t }: Translator = defaultTranslator): string {
	if (change.target === "note") {
		const what = snippet((change.afterNote ?? change.beforeNote)?.title ?? change.after ?? change.before);
		return t(`notebook.review.change.note.${change.action}`, { what });
	}
	return t(`notebook.review.change.fact.${change.action}`, { what: snippet(change.after ?? change.before) });
}

/** Quem pode ser desfeito: não é um "desfazer" e ainda não foi desfeito. */
export const canUndoChange = (change: Pick<MemoryChange, "undoOfId" | "undoneAt">): boolean => !change.undoOfId && !change.undoneAt;

/** Mudanças que o relatório fez, sem as linhas de "desfazer" (elas só marcam a original como desfeita). */
export const reportChanges = (changes: readonly MemoryChange[]): MemoryChange[] => changes.filter((change) => !change.undoOfId);

export function undoErrorMessage(error: unknown, { t }: Translator = defaultTranslator): string {
	const code = error instanceof AtlasApiError && error.status === 409 ? apiErrorCode(error) : null;
	if (code === "stale" || code === "duplicate" || code === "limit" || code === "already_undone") return t(`notebook.review.undoError.${code}`);
	return t("notebook.review.undoError.generic");
}

export type ProposalView = { id: string; badge: string; title: string; detail: string | null; dismissed: boolean };

const DOCTOR_BADGE: Record<DoctorFinding["type"], "duplicate" | "conflict" | "stale"> = { duplicate: "duplicate", conflict: "conflict", stale: "stale" };

/** Proposta do relatório em texto simples: selo, título e detalhe. Nunca expõe ids, classes de falha nem nomes internos. */
export function proposalView(proposal: SleepStoredProposal, { t }: Translator = defaultTranslator): ProposalView {
	const dismissed = proposal.status === "dismissed";
	if (proposal.kind === "skill") return { id: proposal.id, badge: t("notebook.review.proposal.skill"), title: proposal.name, detail: snippet(proposal.description) || null, dismissed };
	if (proposal.kind === "eval_case") return { id: proposal.id, badge: t("notebook.review.proposal.eval_case"), title: t("notebook.review.proposal.evalText", { what: snippet(proposal.input) }), detail: null, dismissed };
	return { id: proposal.id, badge: t(`notebook.review.proposal.${DOCTOR_BADGE[proposal.finding.type] ?? "stale"}`), title: snippet(proposal.finding.reason), detail: null, dismissed };
}
