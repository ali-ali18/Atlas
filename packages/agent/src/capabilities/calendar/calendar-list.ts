// `calendar_list` (F7.1): eventos de um dia ou período da agenda do dono. Leitura de dado PRIVADO e de terceiros (título e
// convidados vêm de quem convidou o dono): `untrusted` + `privateData`, então depois dele uma saída para fora pede aprovação.
import { CALENDAR_LIST_DEFAULT, CALENDAR_LIST_MAX, resolveCalendarRange } from "@workspace/shared";
import { z } from "zod";
import type { CalendarPorts } from "../../ports/calendar.js";
import { defineTool } from "../../tools/define-tool.js";
import { cardEvents, describeEvent, nowStamp, showCard } from "./shared.js";

export function createCalendarListTool(ports: CalendarPorts) {
	return defineTool({
		name: "calendar_list",
		description:
			"List the owner's Google Calendar events for one day (default: today) or a period of up to 31 days, in the owner's time zone. It also tells you the current date and time zone: call it before scheduling anything so you know today's date. " +
			"Use it when the owner asks what is on their agenda, whether they are free, or before creating or moving an event. Do not use it to change anything (calendar_create, calendar_update, calendar_delete).",
		inputSchema: z.object({
			date: z.string().trim().min(1).max(40).optional().describe("One day, YYYY-MM-DD. Default: today."),
			from: z.string().trim().min(1).max(40).optional().describe("First day of a period, YYYY-MM-DD. With to."),
			to: z.string().trim().min(1).max(40).optional().describe("Last day of the period (included), YYYY-MM-DD."),
			limit: z.number().int().min(1).max(CALENDAR_LIST_MAX).optional().describe(`Most events to return (default ${CALENDAR_LIST_DEFAULT}).`),
		}),
		effect: "read",
		trust: "untrusted",
		source: "mcp",
		privateData: true,
		ownerData: "connector",
		async execute({ date, from, to, limit }, ctx) {
			const now = ctx.ports.clock.now();
			const timeZone = await ports.calendar.timeZone(ctx.ownerId);
			const range = resolveCalendarRange({ ...(date !== undefined && { date }), ...(from !== undefined && { from }), ...(to !== undefined && { to }), now, timeZone });
			if (!range.ok) throw new Error(`${range.error} Hint: dates are YYYY-MM-DD in the owner's time zone; a period is at most 31 days.`);
			const max = limit ?? CALENDAR_LIST_DEFAULT;
			const { events, truncated } = await ports.calendar.list(ctx.ownerId, { from: range.from, to: range.to }, { limit: max, ...(ctx.signal && { signal: ctx.signal }) });
			const cardId = `calendar:${ctx.runId}:listed:${range.from}:${range.to}`;
			const shown = await showCard(ports, ctx.ownerId, ctx.runId, { cardId, action: "listed", timeZone, events: cardEvents(events), ...(events.length > 20 && { more: events.length - 20 }) });
			const header = `${nowStamp(now, timeZone)}. Period: ${range.from} to ${range.to} (UTC, end excluded).`;
			if (events.length === 0) return { ok: true, summary: `${header}\nNo events in this period.${shown ? " A card was shown." : ""}` };
			const lines = events.map((event) => `- ${describeEvent(event, timeZone)}`).join("\n");
			const more = truncated ? `\nThere are more events in this period than ${max}: ask for a shorter period or a higher limit.` : "";
			return { ok: true, summary: `${header}\n${events.length} event${events.length === 1 ? "" : "s"}${shown ? " (a card was shown; do not repeat every field)" : ""}:\n${lines}${more}` };
		},
	});
}
