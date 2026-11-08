// Peças comuns das tools de calendário (F7.1): cartão, linha de evento e o aviso de data errada.
import { CALENDAR_CARD_EVENTS_MAX, formatCalendarWhen, toCalendarCardEvent, type CalendarEventView } from "@workspace/shared";
import type { CalendarCardPayload, CalendarPorts } from "../../ports/calendar.js";
import type { RiskEvent } from "../../tools/types.js";

/** Evento do cartão de aprovação a partir de um evento (ou rascunho) já com instantes ISO. */
export function riskEvent(action: RiskEvent["action"], event: { title?: string; start?: string; end?: string; allDay?: boolean; location?: string; attendees?: readonly string[] }, extra: { timeZone?: string; notifyGuests?: boolean } = {}): RiskEvent {
	const guests = event.attendees && event.attendees.length > 0 ? [...event.attendees] : undefined;
	return {
		action,
		...(event.title && { title: event.title }),
		...(event.start && { start: event.start }),
		...(event.end && { end: event.end }),
		...(event.allDay !== undefined && { allDay: event.allDay }),
		...(extra.timeZone && { timeZone: extra.timeZone }),
		...(event.location && { location: event.location }),
		...(guests && { guests }),
		...(extra.notifyGuests !== undefined && { notifyGuests: extra.notifyGuests }),
	};
}

/** "2026-11-10 14:00–15:00 | Reunião @ Sala 2 | 3 guests | id abc". Só título e local: a descrição só vem em `calendar_get`. */
export function describeEvent(event: CalendarEventView, timeZone: string): string {
	const parts = [formatCalendarWhen(event, timeZone), event.title || "(no title)"];
	if (event.location) parts[1] += ` @ ${event.location}`;
	if (event.attendees && event.attendees.length > 0) parts.push(`${event.attendees.length} guest${event.attendees.length === 1 ? "" : "s"}`);
	if (event.free) parts.push("marked free");
	if (event.selfResponse === "declined") parts.push("owner declined");
	parts.push(`id ${event.id}`);
	return parts.join(" | ");
}

/** "Now: 2026-11-10 09:00 (Tuesday, America/Sao_Paulo)". O modelo não sabe a data; toda tool de calendário a devolve. */
export function nowStamp(now: Date, timeZone: string): string {
	const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
	const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now);
	return `Now: ${stamp} (${weekday}, ${timeZone})`;
}

/** Mostra o cartão quando a porta de cartões existe (chat). No run de agenda não há cartão. */
export async function showCard(ports: CalendarPorts, ownerId: string, runId: string, card: CalendarCardPayload): Promise<boolean> {
	if (!ports.cards) return false;
	await ports.cards.show(ownerId, runId, card);
	return true;
}

export function cardEvents(events: readonly CalendarEventView[], conflictIds: ReadonlySet<string> = new Set()) {
	return events.slice(0, CALENDAR_CARD_EVENTS_MAX).map((event) => toCalendarCardEvent(event, conflictIds.has(event.id)));
}

/**
 * Identidade estável do cartão: a MESMA chamada refeita (retomada) não duplica, mas duas alterações do mesmo evento no
 * run são dois cartões (cada um mostra o que mudou naquela vez).
 */
export const eventCardId = (runId: string, eventId: string, action: string, callId?: string) => `calendar:${runId}:${action}:${eventId}${callId ? `:${callId}` : ""}`;
