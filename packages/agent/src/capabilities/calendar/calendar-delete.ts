// `calendar_delete` (F7.1): apaga um evento do Google Agenda do dono. `destructive` com `confirm: "always"`: o dono confirma
// toda vez, em qualquer autonomia. Os convidados NÃO são avisados (o resumo diz).
import { formatCalendarWhen } from "@workspace/shared";
import { z } from "zod";
import type { CalendarPorts } from "../../ports/calendar.js";
import { defineTool } from "../../tools/define-tool.js";
import { riskEvent } from "./shared.js";

export function createCalendarDeleteTool(ports: CalendarPorts) {
	return defineTool({
		name: "calendar_delete",
		description:
			"Delete one event from the owner's Google Calendar by id (from calendar_list). The owner always confirms first. Guests are not emailed about the cancellation: say so if the event had guests. " +
			"Use it only when the owner asks to remove or cancel an event. Do not use it to move or edit (calendar_update).",
		inputSchema: z.object({ eventId: z.string().trim().min(1).max(300) }),
		effect: "destructive",
		confirm: "always",
		// O cartão diz QUAL evento: a leitura completa título, horário e convidados (o texto do cartão é do front, no idioma do dono).
		riskFacts: () => ({ irreversible: true, event: riskEvent("delete", {}) }),
		async enrichRiskFacts({ eventId }, base, ctx) {
			const [existing, timeZone] = await Promise.all([ports.calendar.get(ctx.ownerId, eventId, ctx.signal), ports.calendar.timeZone(ctx.ownerId)]);
			return existing ? { ...base, event: riskEvent("delete", existing, { timeZone, notifyGuests: false }) } : base;
		},
		async execute({ eventId }, ctx) {
			const [existing, timeZone] = await Promise.all([ports.calendar.get(ctx.ownerId, eventId, ctx.signal), ports.calendar.timeZone(ctx.ownerId)]);
			if (!existing) return { ok: false, error: `No event "${eventId}" on the owner's calendar.`, hint: "Call calendar_list for the ids." };
			const removed = await ports.calendar.remove(ctx.ownerId, eventId, ctx.signal);
			if (!removed) return { ok: false, error: `No event "${eventId}" on the owner's calendar.`, hint: "Call calendar_list for the ids." };
			const guests = existing.attendees && existing.attendees.length > 0 ? ` Its ${existing.attendees.length} guest${existing.attendees.length === 1 ? " was" : "s were"} not emailed about the cancellation.` : "";
			return {
				ok: true,
				summary: `Deleted "${existing.title}" (${formatCalendarWhen(existing, timeZone)}).${guests}`,
				receipt: { what: `Event deleted: ${existing.title}`, where: "Google Calendar", externalId: eventId },
			};
		},
	});
}
