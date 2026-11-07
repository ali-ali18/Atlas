/**
 * Frases da Agenda da Biblioteca no idioma da tela. A rota entrega os dados estruturados (`AgendaItemView`); aqui eles
 * viram "Amanhã às 10:00", "A cada 2 h até 20/11", "Quando chegar e-mail de …". Puro: o relógio (`now`) e o fuso entram
 * por parâmetro. Nada de tipo interno na tela: o item é "Lembrete", "Acompanhando" ou "Esperando e-mail".
 */
import type { AgendaEndReasonView, AgendaItemView } from "@workspace/shared";
import { formatDate, formatTime } from "@/lib/format";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { intervalSummaryLabel } from "@/lib/shared-labels";
import { memoryRelativeDate } from "./memory-tab-helpers";
import { emailTriggerText } from "./routine-text";

function kindText(kind: AgendaItemView["kind"], { t }: Translator): string {
	switch (kind) {
		case "remind":
			return t("agenda.kind.remind");
		case "watch":
			return t("agenda.kind.watch");
		case "intent":
			return t("agenda.kind.intent");
		case "brief":
			return t("agenda.kind.brief");
	}
}

function endText(reason: AgendaEndReasonView, { t }: Translator): string {
	switch (reason) {
		case "owner":
			return t("agenda.end.owner");
		case "completed":
			return t("agenda.end.completed");
		case "done":
			return t("agenda.end.done");
		case "expired":
			return t("agenda.end.expired");
		case "max_runs":
			return t("agenda.end.max_runs");
		case "ignored_notices":
			return t("agenda.end.ignored_notices");
		case "no_result":
			return t("agenda.end.no_result");
		case "unavailable":
			return t("agenda.end.unavailable");
		case "reminder_note":
			return t("agenda.end.reminder_note");
		case "other":
			return t("agenda.end.other");
	}
}

export type AgendaState = "active" | "paused" | "ended";

export const agendaState = (item: Pick<AgendaItemView, "status">): AgendaState =>
	item.status === "pending" ? "active" : item.status === "paused" ? "paused" : "ended";

export const agendaKindLabel = (kind: AgendaItemView["kind"], translator: Translator = defaultTranslator): string => kindText(kind, translator);

/** Por que acabou, em uma frase simples. Sem motivo conhecido, só "Encerrado". */
export const agendaEndText = (reason: AgendaEndReasonView | null, translator: Translator = defaultTranslator): string => endText(reason ?? "other", translator);

/** Chave AAAA-MM-DD do dia civil de `date` no fuso (para comparar "hoje" e "amanhã" sem depender do fuso do navegador). */
function dayKey(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** "Hoje às 14:30", "Amanhã às 10:00" ou "08/11 às 10:00": o horário no fuso do dono. */
export function agendaWhen(iso: string, timeZone: string, now: Date, translator: Translator = defaultTranslator): string {
	const { t, locale } = translator;
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "—";
	const time = formatTime(at, locale, { timeZone });
	const key = dayKey(at, timeZone);
	if (key === dayKey(now, timeZone)) return t("agenda.when.today", { time });
	// Meio-dia UTC do dia civil de hoje + 24 h cai sempre no dia seguinte, mesmo na virada de horário de verão.
	const [y, m, d] = dayKey(now, timeZone).split("-").map(Number);
	const tomorrow = new Date(Date.UTC(y!, m! - 1, d!, 12) + 24 * 60 * 60 * 1000);
	if (key === tomorrow.toISOString().slice(0, 10)) return t("agenda.when.tomorrow", { time });
	return t("agenda.when.date", { date: formatDate(at, locale, { day: "2-digit", month: "2-digit", timeZone }), time });
}

const shortDate = (iso: string, timeZone: string, { locale }: Translator): string => formatDate(iso, locale, { day: "2-digit", month: "2-digit", timeZone });

/**
 * A frase de quando/o que dispara. Uma vez: o horário. Repete: "A cada 2 h até 20/11". Espera e-mail: "Quando chegar
 * e-mail de …". Encerrado sem horário e sem filtro: nada (o cartão mostra o motivo no lugar).
 */
export function agendaSummary(item: AgendaItemView, timeZone: string, now: Date, translator: Translator = defaultTranslator): string | null {
	const { t } = translator;
	if (item.kind === "intent" || item.event) {
		const base = emailTriggerText({ fromContains: item.event?.from, subjectContains: item.event?.subjectContains }, translator);
		return item.event?.hasAttachment ? t("agenda.attachment", { summary: base }) : base;
	}
	if (item.intervalMinutes !== null) {
		const every = intervalSummaryLabel(item.intervalMinutes, translator);
		return item.untilAt ? t("agenda.until", { summary: every, date: shortDate(item.untilAt, timeZone, translator) }) : every;
	}
	return item.nextAt ? agendaWhen(item.nextAt, timeZone, now, translator) : null;
}

/** Segunda linha do cartão: próxima conferência (itens que repetem), vigência (esperas por e-mail) ou o aviso de pausa. */
export function agendaNextLine(item: AgendaItemView, timeZone: string, now: Date, translator: Translator = defaultTranslator): string | null {
	const { t } = translator;
	const state = agendaState(item);
	if (state === "paused") return t("agenda.paused");
	if (state === "ended") return null;
	if (item.kind === "intent") return item.untilAt ? t("agenda.validUntil", { date: shortDate(item.untilAt, timeZone, translator) }) : null;
	if (item.intervalMinutes !== null && item.nextAt) return t("agenda.next", { when: agendaWhen(item.nextAt, timeZone, now, translator) });
	return null;
}

/** Última novidade ("Novidade há 2 h: …") ou, se o bot só conferiu, "Conferi há 2 h, sem novidades". */
export function agendaLastLine(item: AgendaItemView, timeZone: string, now: Date, translator: Translator = defaultTranslator): string | null {
	const { t, locale } = translator;
	const last = item.lastUpdate;
	if (!last) return null;
	const when = memoryRelativeDate(last.at, now, timeZone, locale);
	if (!when) return null;
	if (last.outcome === "no_change") return t("agenda.lastChecked", { when });
	return last.message ? t("agenda.lastUpdate", { when, message: last.message }) : t("agenda.lastUpdateNoText", { when });
}

export type AgendaCardModel = {
	id: string;
	note: string;
	kind: string;
	state: AgendaState;
	stateLabel: string;
	summary: string | null;
	next: string | null;
	last: string | null;
	/** Só nos encerrados. */
	endText: string | null;
};

export function agendaCardModel(item: AgendaItemView, timeZone: string, now: Date, translator: Translator = defaultTranslator): AgendaCardModel {
	const state = agendaState(item);
	return {
		id: item.id,
		note: item.note,
		kind: agendaKindLabel(item.kind, translator),
		state,
		stateLabel: translator.t(`agenda.state.${state}`),
		summary: agendaSummary(item, timeZone, now, translator),
		next: agendaNextLine(item, timeZone, now, translator),
		last: agendaLastLine(item, timeZone, now, translator),
		endText: state === "ended" ? agendaEndText(item.endReason, translator) : null,
	};
}

/** Troca o item na lista depois de uma ação: cancelado vai para o topo dos encerrados; o resto fica onde estava. */
export function applyAgendaChange<T extends { items: AgendaItemView[]; ended: AgendaItemView[] }>(data: T, item: AgendaItemView): T {
	const active = item.status === "pending" || item.status === "paused";
	if (active) return { ...data, items: data.items.map((current) => (current.id === item.id ? item : current)) };
	return { ...data, items: data.items.filter((current) => current.id !== item.id), ended: [item, ...data.ended.filter((current) => current.id !== item.id)] };
}
