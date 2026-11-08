// `calendar_create` (F7.1): cria um evento no Google Agenda do dono e AVISA se ele bate com outro (por horário).
//
// Efeito: `write_external` (muda sistema de terceiro). Com convidados vira `send`: o Google manda o convite por e-mail em
// nome do dono, então a decisão é a de um envio (aprovação em qualquer autonomia; sem dono presente a tool nem é oferecida).
// Duas verificações estruturais antes de criar: data no passado (o modelo errou o dia) e conflito de horário (informa e cria).
import { findCalendarConflicts, formatCalendarWhen, normalizeCalendarEventInput } from "@workspace/shared";
import { z } from "zod";
import type { CalendarPorts } from "../../ports/calendar.js";
import { defineTool } from "../../tools/define-tool.js";
import { cardEvents, describeEvent, eventCardId, nowStamp, showCard } from "./shared.js";

/** Início mais antigo que isto (em relação a agora) é quase certamente o dia errado, não um pedido do dono. */
const PAST_TOLERANCE_MS = 10 * 60_000;

export const eventFields = {
	title: z.string().trim().min(1).max(200),
	location: z.string().trim().max(200).optional(),
	description: z.string().trim().max(2000).optional(),
	attendees: z.array(z.string().trim().min(3).max(254)).max(20).optional(),
};

export function createCalendarCreateTool(ports: CalendarPorts) {
	return defineTool({
		name: "calendar_create",
		description:
			"Create an event on the owner's Google Calendar and show its card. It tells you if the time overlaps another event. Use it when the owner asks to schedule, book or add something to the calendar; call calendar_list first to learn today's date and what is already there. " +
			"Give start as YYYY-MM-DDTHH:MM in the owner's time zone (or YYYY-MM-DD for an all-day event) and end or durationMinutes (default 60). " +
			"Adding attendees sends them an email invite from the owner and always asks the owner first: add only the people the owner named. Do not use it to change an existing event (calendar_update) or for a reminder to the owner (remind_me).",
		inputSchema: z.object({
			...eventFields,
			start: z.string().trim().min(1).max(40).describe("YYYY-MM-DDTHH:MM in the owner's time zone, or YYYY-MM-DD for all-day."),
			end: z.string().trim().min(1).max(40).optional().describe("Same format as start. Or use durationMinutes."),
			durationMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
		}),
		effect: "write_external",
		effectForArgs: ({ attendees }) => (attendees !== undefined && attendees.length > 0 ? "send" : "write_external"),
		riskFacts: ({ title, start, attendees }) => ({
			target: `Google Calendar: ${title} (${start})`,
			...(attendees && attendees.length > 0 && { recipients: attendees, externalRecipients: attendees }),
		}),
		async execute(args, ctx) {
			const now = ctx.ports.clock.now();
			const timeZone = await ports.calendar.timeZone(ctx.ownerId);
			const parsed = normalizeCalendarEventInput(args, timeZone);
			if (!parsed.ok) throw new Error(`${parsed.error} Hint: fix that field and call again.`);
			const draft = parsed.value;
			const startMs = draft.allDay ? Date.parse(`${draft.end}T00:00:00Z`) : Date.parse(draft.start);
			const pastLimit = draft.allDay ? now.getTime() - 36 * 3_600_000 : now.getTime() - PAST_TOLERANCE_MS;
			if (startMs < pastLimit) throw new Error(`That time is in the past. ${nowStamp(now, timeZone)}. Hint: check the date with calendar_list (it prints today's date) and call again with the right day.`);
			const notifyGuests = draft.attendees.length > 0;

			// Conflitos: melhor esforço. Não conseguir ler a agenda não impede criar, mas a tool diz que não conferiu.
			let conflictNote: string;
			let conflicts: Awaited<ReturnType<typeof ports.calendar.list>>["events"] = [];
			try {
				const near = draft.allDay ? { events: [], truncated: false } : await ports.calendar.list(ctx.ownerId, { from: draft.start, to: draft.end }, { limit: 50, ...(ctx.signal && { signal: ctx.signal }) });
				conflicts = findCalendarConflicts(near.events, draft);
				conflictNote = draft.allDay ? "All-day events do not block the calendar, so no overlap check was needed." : conflicts.length === 0 ? "No overlap with other events." : `OVERLAPS ${conflicts.length} event${conflicts.length === 1 ? "" : "s"}: ${conflicts.map((c) => describeEvent(c, timeZone)).join("; ")}. Tell the owner in plain words and offer to move it.`;
			} catch (error) {
				if (ctx.signal?.aborted) throw error;
				conflictNote = `The overlap check failed (${error instanceof Error ? error.message : "unknown error"}), so overlaps are unknown; say that.`;
			}

			const created = await ports.calendar.create(ctx.ownerId, draft, { notifyGuests, ...(ctx.callId && { requestKey: ctx.callId }), ...(ctx.signal && { signal: ctx.signal }) });
			const conflictIds = new Set(conflicts.length > 0 ? [created.id] : []);
			const shown = await showCard(ports, ctx.ownerId, ctx.runId, { cardId: eventCardId(ctx.runId, created.id, "created", ctx.callId), action: "created", timeZone, events: cardEvents([created], conflictIds), ...(notifyGuests && { notified: true }) });
			const guests = notifyGuests ? ` Invitations were emailed to ${draft.attendees.join(", ")}.` : "";
			return {
				ok: true,
				summary: `Created "${created.title}" on ${formatCalendarWhen(created, timeZone)} (${timeZone}), event ${created.id}.${shown ? " A card was shown." : ""}${guests} ${conflictNote}`,
				receipt: { what: `Event created: ${created.title}`, where: "Google Calendar", externalId: created.id, ...(created.link && { url: created.link }) },
			};
		},
	});
}
