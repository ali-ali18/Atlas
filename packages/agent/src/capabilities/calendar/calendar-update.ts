// `calendar_update` (F7.1): altera um evento do Google Agenda do dono. Mesma regra de efeito do `calendar_create`: com
// convidados na chamada, ou com `notifyGuests`, o Google manda e-mail aos convidados em nome do dono, então é `send`.
// Sem isso nenhum e-mail sai (o padrão é não avisar: reagendar não deve incomodar ninguém sem o dono saber).
import { findCalendarConflicts, formatCalendarWhen, mergeCalendarEventPatch } from "@workspace/shared";
import { z } from "zod";
import type { CalendarPorts } from "../../ports/calendar.js";
import { defineTool } from "../../tools/define-tool.js";
import { eventFields } from "./calendar-create.js";
import { cardEvents, describeEvent, eventCardId, nowStamp, riskEvent, showCard } from "./shared.js";

const PAST_TOLERANCE_MS = 10 * 60_000;

export function createCalendarUpdateTool(ports: CalendarPorts) {
	return defineTool({
		name: "calendar_update",
		description:
			"Change an existing event on the owner's Google Calendar (title, time, place, description or guests) and show its card. Give only what changes; an empty location or description clears it; attendees REPLACES the whole guest list. Changing only start keeps the duration. It tells you if the new time overlaps another event. " +
			"Use it when the owner asks to move, rename or edit an event (get the id from calendar_list). Guests are NOT emailed unless notifyGuests is true or you pass attendees; emailing always asks the owner first. For a recurring series this changes the single occurrence you give. Do not use it to delete (calendar_delete) or create (calendar_create).",
		inputSchema: z.object({
			eventId: z.string().trim().min(1).max(300),
			title: eventFields.title.optional(),
			start: z.string().trim().min(1).max(40).optional().describe("YYYY-MM-DDTHH:MM in the owner's time zone, or YYYY-MM-DD for all-day."),
			end: z.string().trim().min(1).max(40).optional(),
			durationMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
			location: eventFields.location,
			description: eventFields.description,
			attendees: eventFields.attendees,
			notifyGuests: z.boolean().optional().describe("true to email the current guests about this change. Default false."),
		}),
		effect: "write_external",
		effectForArgs: ({ attendees, notifyGuests }) => ((attendees !== undefined && attendees.length > 0) || notifyGuests === true ? "send" : "write_external"),
		riskFacts: ({ title, location, attendees, notifyGuests }) => ({
			event: riskEvent("update", { ...(title && { title }), ...(location && { location }), ...(attendees && { attendees }) }, { notifyGuests: notifyGuests === true || (attendees !== undefined && attendees.length > 0) }),
			...(attendees && attendees.length > 0 && { recipients: attendees, externalRecipients: attendees }),
		}),
		// Lê o evento: o cartão mostra como ele ficará e, com aviso, os convidados que realmente recebem o e-mail
		// (os do evento, quando o pedido só liga `notifyGuests`).
		async enrichRiskFacts({ eventId, notifyGuests, ...patch }, base, ctx) {
			const [existing, timeZone] = await Promise.all([ports.calendar.get(ctx.ownerId, eventId, ctx.signal), ports.calendar.timeZone(ctx.ownerId)]);
			if (!existing) return base;
			const merged = mergeCalendarEventPatch(existing, patch, timeZone);
			const after = merged.ok ? merged.value : existing;
			const notify = notifyGuests === true || (patch.attendees !== undefined && patch.attendees.length > 0);
			const guests = notify ? after.attendees ?? [] : [];
			return { ...base, event: riskEvent("update", after, { timeZone, notifyGuests: notify }), ...(guests.length > 0 && { recipients: guests, externalRecipients: guests }) };
		},
		async execute({ eventId, notifyGuests, ...patch }, ctx) {
			const now = ctx.ports.clock.now();
			const timeZone = await ports.calendar.timeZone(ctx.ownerId);
			const existing = await ports.calendar.get(ctx.ownerId, eventId, ctx.signal);
			if (!existing) return { ok: false, error: `No event "${eventId}" on the owner's calendar.`, hint: "Call calendar_list for the ids." };
			const merged = mergeCalendarEventPatch(existing, patch, timeZone);
			if (!merged.ok) throw new Error(`${merged.error} Hint: fix that field and call again.`);
			const { value: draft, changed } = merged;
			if (changed.includes("time") && !draft.allDay && Date.parse(draft.start) < now.getTime() - PAST_TOLERANCE_MS) {
				throw new Error(`The new time is in the past. ${nowStamp(now, timeZone)}. Hint: check the date with calendar_list and call again with the right day.`);
			}
			const notify = notifyGuests === true || (patch.attendees !== undefined && patch.attendees.length > 0);

			let conflictNote = "";
			let conflicts: Awaited<ReturnType<typeof ports.calendar.list>>["events"] = [];
			if (changed.includes("time") && !draft.allDay) {
				try {
					const near = await ports.calendar.list(ctx.ownerId, { from: draft.start, to: draft.end }, { limit: 50, ...(ctx.signal && { signal: ctx.signal }) });
					conflicts = findCalendarConflicts(near.events, { ...draft, ignoreId: eventId });
					conflictNote = conflicts.length === 0 ? " No overlap with other events." : ` OVERLAPS ${conflicts.length} event${conflicts.length === 1 ? "" : "s"}: ${conflicts.map((c) => describeEvent(c, timeZone)).join("; ")}. Tell the owner in plain words.`;
				} catch (error) {
					if (ctx.signal?.aborted) throw error;
					conflictNote = ` The overlap check failed (${error instanceof Error ? error.message : "unknown error"}), so overlaps are unknown; say that.`;
				}
			}

			const updated = await ports.calendar.update(ctx.ownerId, eventId, { draft, changed }, { notifyGuests: notify, ...(ctx.callId && { requestKey: ctx.callId }), ...(ctx.signal && { signal: ctx.signal }) });
			if (!updated) return { ok: false, error: `No event "${eventId}" on the owner's calendar.`, hint: "Call calendar_list for the ids." };
			const shown = await showCard(ports, ctx.ownerId, ctx.runId, {
				cardId: eventCardId(ctx.runId, updated.id, "updated", ctx.callId),
				action: "updated",
				timeZone,
				events: cardEvents([updated], new Set(conflicts.length > 0 ? [updated.id] : [])),
				...(notify && { notified: true }),
			});
			const guests = notify ? " Guests were emailed." : updated.attendees && updated.attendees.length > 0 ? " Guests were not emailed." : "";
			return {
				ok: true,
				summary: `Updated "${updated.title}" (${changed.join(", ")}): ${formatCalendarWhen(updated, timeZone)} (${timeZone}).${shown ? " A card was shown." : ""}${guests}${conflictNote}`,
				receipt: { what: `Event updated: ${updated.title}`, where: "Google Calendar", externalId: updated.id, ...(updated.link && { url: updated.link }) },
			};
		},
	});
}
