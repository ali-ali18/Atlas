/**
 * Fatos de evento de agenda e de e-mail do cartão de aprovação (F7). Funções puras: `riskFacts` é tipado pelo motor,
 * mas o cliente não confia em formato. O texto que o dono lê é montado em cada tela (web, celular), no idioma dele,
 * a partir destes campos; aqui só entra a leitura e a formatação de horário por `Intl` (sem palavra fixa em idioma).
 */

const MAX_TITLE = 300;
const MAX_BODY = 20_000;
const MAX_GUESTS = 20;

const text = (value: unknown, max: number): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
};

export type ApprovalEventFact = {
	action: "create" | "update" | "delete";
	title?: string;
	start?: string;
	end?: string;
	allDay: boolean;
	timeZone?: string;
	location?: string;
	guests: string[];
	notifyGuests?: boolean;
};

/** O evento a que o pedido de aprovação se refere, ou `null` se não há (ou vem malformado). */
export function approvalEventFact(riskFacts: Record<string, unknown>): ApprovalEventFact | null {
	const raw = riskFacts.event;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const e = raw as Record<string, unknown>;
	if (e.action !== "create" && e.action !== "update" && e.action !== "delete") return null;
	const title = text(e.title, MAX_TITLE);
	const start = text(e.start, 40);
	const end = text(e.end, 40);
	const timeZone = text(e.timeZone, 80);
	const location = text(e.location, MAX_TITLE);
	const guests = Array.isArray(e.guests) ? e.guests.map((g) => text(g, 254)).filter((g): g is string => g !== undefined).slice(0, MAX_GUESTS) : [];
	return {
		action: e.action,
		...(title && { title }),
		...(start && { start }),
		...(end && { end }),
		allDay: e.allDay === true,
		...(timeZone && { timeZone }),
		...(location && { location }),
		guests,
		...(typeof e.notifyGuests === "boolean" && { notifyGuests: e.notifyGuests }),
	};
}

const validZone = (zone: string | undefined): string | undefined => {
	if (!zone) return undefined;
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return zone;
	} catch {
		return undefined;
	}
};

/** "qui., 5 de nov., 14:00 – 15:00" no idioma e no fuso do evento. `null` sem horário legível. Dia inteiro: `end` é exclusivo. */
export function formatApprovalEventWhen(event: Pick<ApprovalEventFact, "start" | "end" | "allDay" | "timeZone">, locale: string): string | null {
	if (!event.start) return null;
	try {
		if (event.allDay) {
			const first = new Date(`${event.start.slice(0, 10)}T00:00:00Z`);
			const lastRaw = event.end ? new Date(`${event.end.slice(0, 10)}T00:00:00Z`).getTime() - 86_400_000 : first.getTime();
			const last = new Date(Math.max(first.getTime(), lastRaw));
			if (Number.isNaN(first.getTime())) return null;
			return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).formatRange(first, last);
		}
		const start = new Date(event.start);
		if (Number.isNaN(start.getTime())) return null;
		const end = event.end ? new Date(event.end) : start;
		const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...(validZone(event.timeZone) && { timeZone: validZone(event.timeZone) }) });
		return Number.isNaN(end.getTime()) || end.getTime() <= start.getTime() ? fmt.format(start) : fmt.formatRange(start, end);
	} catch {
		return null;
	}
}

export type ApprovalMessageFact = { subject?: string; body: string; from?: "gmail" | "bot"; reply: boolean };

/** O e-mail que vai sair (assunto e corpo inteiro), ou `null`. Não traz `source` nem `in_reply_to`: são internos. */
export function approvalMessageFact(riskFacts: Record<string, unknown>): ApprovalMessageFact | null {
	const raw = riskFacts.message;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const m = raw as Record<string, unknown>;
	const body = typeof m.body === "string" ? m.body.trim().slice(0, MAX_BODY) : "";
	if (body.length === 0) return null;
	const subject = text(m.subject, MAX_TITLE);
	return { ...(subject && { subject }), body, ...((m.from === "gmail" || m.from === "bot") && { from: m.from }), reply: m.reply === true };
}
