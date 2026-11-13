// `brief_set` (F7.2): o plano do dia todo dia, na hora que o dono pediu. Um por bot: pedir de novo ATUALIZA o existente
// (horário e foco) em vez de duplicar. O horário é exato (a agenda do v4 não tem horário de silêncio).
// O texto do plano (e-mail, agenda, caderno, pendências, entregas) é montado no run de agenda do brief, não aqui.
import { AGENDA_NOTE_MAX_CHARS, nextLocalTimeAfter, parseClockMinutes, planAgendaItem } from "@workspace/shared";
import { z } from "zod";
import type { Agenda } from "../../ports/agenda.js";
import { defineTool } from "../../tools/define-tool.js";

/** Nota do brief sem foco do dono: o que preparar. Em inglês: vai para o modelo do run futuro. */
export const BRIEF_DEFAULT_NOTE = "Prepare the owner's day plan: today's commitments, emails that need action, pending items and deliveries.";

/** "2026-11-05 07:30" no fuso do dono. */
function localStamp(iso: string, timeZone: string): string {
	return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export function createBriefSetTool(agenda: Agenda) {
	return defineTool({
		name: "brief_set",
		description:
			"Set up the owner's daily plan: every day at the exact time they ask, you send ONE Day plan card with their commitments, emails that need action, pending items and deliveries. " +
			"Use it when the owner asks for a morning briefing, a daily summary or 'send me my day plan at 7:30'. There is one daily plan per owner: calling it again changes the time or focus instead of adding another. To stop it, use agenda_list and agenda_change (cancel). " +
			"Do not use it for a one-off reminder (remind_me) or a recurring check (watch). Confirm to the owner in one short sentence with the time.",
		inputSchema: z.object({
			time: z.string().trim().min(3).max(5).describe("Time of day, 24-hour HH:MM in the owner's time zone, exactly as asked (07:30)."),
			focus: z.string().trim().min(1).max(600).optional().describe("What the owner wants emphasized or left out (for example 'skip emails, focus on classes'). Omit for the standard plan."),
		}),
		effect: "write_internal",
		riskFacts: () => ({ target: "Agenda (daily plan)" }),
		async execute({ time, focus }, ctx) {
			const minutes = parseClockMinutes(time);
			if (minutes === null) return { ok: false, error: `time "${time}" is not a 24-hour HH:MM time.`, hint: "Use for example 07:30 or 18:00." };
			const settings = await agenda.settings(ctx.ownerId);
			const now = ctx.ports.clock.now();
			const first = nextLocalTimeAfter(minutes, now, settings.timezone);
			const note = focus ? `${BRIEF_DEFAULT_NOTE} Owner's focus: ${focus}`.slice(0, AGENDA_NOTE_MAX_CHARS) : BRIEF_DEFAULT_NOTE;
			const planned = planAgendaItem({ request: { kind: "brief", note, when: first.toISOString() }, now, settings });
			if (!planned.ok) return { ok: false, error: planned.error, hint: "Fix the field named in the error and call again." };
			const created = await agenda.create(ctx.ownerId, planned.plan, { sourceRunId: ctx.runId, untrustedRead: ctx.untrustedReadInRun === true });
			if (!created.ok) return { ok: false, error: created.error, hint: "Use agenda_list to see the active items, then agenda_change to cancel one." };
			const { item } = created;
			const verb = created.updated ? "Updated the existing daily plan" : "Scheduled the daily plan";
			return {
				ok: true,
				summary: `${verb} (${item.id}): every day at ${time} (${settings.timezone}), next one ${localStamp(item.nextRunAt, settings.timezone)}. It always posts one Day plan card at that time, even when the day is quiet. Confirm to the owner in one short sentence.`,
				receipt: { what: created.updated ? "Agenda: daily plan updated" : "Agenda: daily plan scheduled", where: "Agenda", externalId: item.id },
			};
		},
	});
}
