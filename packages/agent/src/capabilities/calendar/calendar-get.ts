// `calendar_get` (F7.1): um evento por id, com descrição e convidados. A descrição é texto de terceiro: dado, nunca instrução.
import { formatCalendarWhen } from "@workspace/shared";
import { z } from "zod";
import type { CalendarPorts } from "../../ports/calendar.js";
import { defineTool } from "../../tools/define-tool.js";

export function createCalendarGetTool(ports: CalendarPorts) {
	return defineTool({
		name: "calendar_get",
		description:
			"Read one calendar event by id (from calendar_list or calendar_create): time, place, description and guest addresses. Use it when the owner asks for the details of an event or before changing one. Do not use it to look for events (calendar_list).",
		inputSchema: z.object({ eventId: z.string().trim().min(1).max(300) }),
		effect: "read",
		trust: "untrusted",
		source: "mcp",
		privateData: true,
		ownerData: "connector",
		async execute({ eventId }, ctx) {
			const [event, timeZone] = await Promise.all([ports.calendar.get(ctx.ownerId, eventId, ctx.signal), ports.calendar.timeZone(ctx.ownerId)]);
			if (!event) return { ok: false, error: `No event "${eventId}" on the owner's calendar.`, hint: "Call calendar_list for the ids." };
			const lines = [`id: ${event.id}`, `title: ${event.title || "(no title)"}`, `when: ${formatCalendarWhen(event, timeZone)} (${timeZone})`];
			if (event.location) lines.push(`place: ${event.location}`);
			if (event.attendees && event.attendees.length > 0) lines.push(`guests: ${event.attendees.join(", ")}`);
			if (event.free) lines.push("shown as free");
			if (event.cancelled) lines.push("cancelled");
			if (event.description) lines.push(`description: ${event.description}`);
			return { ok: true, summary: lines.join("\n") };
		},
	});
}
