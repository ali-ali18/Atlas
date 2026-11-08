// Cartões do dia no celular (F7): plano do dia, agenda e e-mail (triagem e rascunho). Parte pura, sem React: textos em
// pt-BR (o celular ainda não tem i18n) iguais aos do web e a ordem do que aparece. Dados já validados por `shared`.
import type { CalendarCardEvent, DayPlanSectionId, DayPlanSource, DayPlanSourceError, EmailSourceId, EmailTriageCategory, EmailTriageEntry } from "@workspace/shared";

export const DAY_PLAN_TITLE = "Plano do dia";

const SECTION_TITLE: Record<DayPlanSectionId, string> = { commitments: "Compromissos", emails: "E-mails que pedem ação", pending: "Pendências", deliveries: "Entregas" };
export const dayPlanSectionTitle = (id: DayPlanSectionId): string => SECTION_TITLE[id];

const ERROR_TEXT: Record<DayPlanSource, string> = {
	calendar: "Não consegui ler a agenda.",
	email: "Não consegui ler os e-mails.",
	agenda: "Não consegui ler seus lembretes.",
	notebook: "Não consegui ler o caderno.",
	purchases: "Não consegui ler suas entregas.",
	tasks: "Não consegui ler suas tarefas.",
};
const RECONNECT_TEXT: Record<DayPlanSource, string> = {
	calendar: "Reconecte o Google Agenda para eu ler seus compromissos.",
	email: "Reconecte o e-mail para eu ler suas mensagens.",
	agenda: "Reconecte para eu ler seus lembretes.",
	notebook: "Reconecte para eu ler o caderno.",
	purchases: "Reconecte para eu ler suas entregas.",
	tasks: "Reconecte para eu ler suas tarefas.",
};
/** Linha de aviso de uma fonte do plano: "reconecte" só para login expirado; o resto é "não consegui ler". */
export const dayPlanErrorText = (error: DayPlanSourceError): string => (error.reason === "needs_connection" ? RECONNECT_TEXT[error.source] : ERROR_TEXT[error.source]);

/** "quinta-feira, 5 de novembro" do dia do plano (data de calendário, sem fuso). */
export function dayPlanDayLabel(date: string): string {
	const parsed = new Date(`${date}T12:00:00Z`);
	if (Number.isNaN(parsed.getTime())) return date;
	return new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(parsed);
}

// ---- agenda ----------------------------------------------------------------------------------------------

export const CALENDAR_TITLE: Record<"created" | "updated" | "listed", string> = { created: "Evento criado", updated: "Evento alterado", listed: "Agenda" };

/** "qui., 5 nov. · 14:00–15:00" (ou "O dia todo"), no fuso do dono; lista só traz a hora. */
export function calendarWhen(event: Pick<CalendarCardEvent, "start" | "end" | "allDay">, timeZone: string, withDay = true): string {
	try {
		if (event.allDay) {
			const day = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${event.start.slice(0, 10)}T12:00:00Z`));
			return withDay ? `${day} · O dia todo` : "O dia todo";
		}
		const day = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "numeric", month: "short", timeZone }).format(new Date(event.start));
		const hour = (iso: string) => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
		return `${withDay ? `${day} · ` : ""}${hour(event.start)}–${hour(event.end)}`;
	} catch {
		return event.start;
	}
}

export const guestsText = (count: number): string => `${count} ${count === 1 ? "convidado" : "convidados"}`;

// ---- e-mail ----------------------------------------------------------------------------------------------

const TRIAGE_ORDER: readonly EmailTriageCategory[] = ["needs_action", "fyi", "ignore"];
const TRIAGE_GROUP: Record<EmailTriageCategory, string> = { needs_action: "Precisa de ação", fyi: "Só para saber", ignore: "Pode ignorar" };

/** Triagem em grupos na ordem do web (ação, saber, ignorar); grupo vazio some. */
export function triageGroups(items: readonly EmailTriageEntry[]): Array<{ category: EmailTriageCategory; title: string; items: EmailTriageEntry[] }> {
	return TRIAGE_ORDER.map((category) => ({ category, title: TRIAGE_GROUP[category], items: items.filter((item) => item.category === category) })).filter((group) => group.items.length > 0);
}

export function triageSummary(items: readonly EmailTriageEntry[]): string {
	const actions = items.filter((item) => item.category === "needs_action").length;
	if (actions === 0) return "Nada pede ação";
	return actions === 1 ? "1 precisa de ação" : `${actions} precisam de ação`;
}

export const triageDeadline = (deadline: string): string => `Prazo: ${deadline.slice(0, 10).split("-").reverse().join("/")}`;

/** Onde o rascunho ficou: o texto diz sempre que nada foi enviado. */
export function draftSavedNote(source: EmailSourceId, saved: boolean): string {
	if (!saved) return "Só existe aqui na conversa. Nada foi enviado; peça para enviar quando estiver bom.";
	return source === "gmail" ? "Guardado nos rascunhos do seu Gmail. Nada foi enviado." : "Guardado na caixa do bot. Nada foi enviado.";
}
