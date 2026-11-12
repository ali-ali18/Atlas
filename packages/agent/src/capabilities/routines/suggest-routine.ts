// `suggest_routine` (F9 parte 2): o bot nota um padrão ("o mesmo pedido de novo e de novo") e oferece uma rotina ao dono. NÃO cria sozinha: no modo
// "sugerir" (padrão do dono) vira um cartão "Posso criar esta rotina?" (Criar / Agora não); só no modo automático que o dono escolheu a rotina
// nasce e o cartão tem "Desfazer". Só vale com o modo proativo ligado no bot principal (o adaptador confere). Quando o dono JÁ pediu a
// rotina, a tool é `routine_create`. Como é ideia do bot (nunca pedido explícito), o intervalo mínimo de 2 h vale sempre.
import { INTERVAL_EVERY_MINUTES_MAX, ALERT_MIN_INTERVAL_MINUTES, validateCronExpression } from "@workspace/shared";
import { z } from "zod";
import type { Routines } from "../../ports/routines.js";
import { defineTool } from "../../tools/define-tool.js";
import { isValidTimezone } from "./routine-trigger.js";

export function createSuggestRoutineTool(routines: Routines) {
	return defineTool({
		name: "suggest_routine",
		description:
			"Offer ONE routine you noticed the owner needs (the same request again and again, a periodic check they keep asking for). Depending on the owner's setting it shows a card asking whether to create it, or creates it and tells them (they can undo). It never creates on its own in suggest mode. " +
			"Use it ONLY for your own idea, at most once per pattern, and only when proactive mode is on. Do not use it when the owner is already asking for a routine (routine_create), for a one-off reminder (remind_me), or if a similar routine exists (routine_list first). " +
			`task is the instruction you will follow on every run, self-contained. Give cron (5 fields) OR everyMinutes (${ALERT_MIN_INTERVAL_MINUTES} to ${INTERVAL_EVERY_MINUTES_MAX}; an idea of yours is never more often than every 2 hours), not both.`,
		inputSchema: z.object({
			name: z.string().trim().min(1).max(80).describe("Short routine name in the owner's language."),
			task: z.string().trim().min(1).max(4000),
			cron: z.string().trim().max(120).optional().describe('5-field cron in the given timezone, like "0 8 * * 1" (Mondays 08:00).'),
			everyMinutes: z.number().int().optional(),
			timezone: z.string().trim().min(1).max(64).optional().describe("IANA timezone; defaults to the owner's."),
		}),
		// Só deixa uma pergunta no chat (ou, no modo automático que o dono escolheu, uma rotina que ele pode desfazer): escrita interna.
		effect: "write_internal",
		riskFacts: ({ name }) => ({ target: `routine suggestion ${name}` }),
		async execute(args, ctx) {
			if (args.cron !== undefined && args.everyMinutes !== undefined) return { ok: false, error: "Use cron OR everyMinutes, not both.", hint: "Pick one: cron for fixed clock times, everyMinutes for a steady interval." };
			if (args.cron === undefined && args.everyMinutes === undefined) return { ok: false, error: "Give cron (5 fields) or everyMinutes.", hint: 'Like cron "0 8 * * 1" or everyMinutes 240.' };
			const cron = args.cron === undefined ? undefined : validateCronExpression(args.cron);
			if (args.cron !== undefined && cron && !cron.ok) return { ok: false, error: `cron "${args.cron.slice(0, 60)}" is not a valid cron: ${cron.reason}`, hint: 'Use 5 fields (minute hour day month weekday) with numbers, like "0 8 * * 1".' };
			if (args.everyMinutes !== undefined && (args.everyMinutes < ALERT_MIN_INTERVAL_MINUTES || args.everyMinutes > INTERVAL_EVERY_MINUTES_MAX)) {
				return { ok: false, error: `everyMinutes ${args.everyMinutes} is not allowed for a suggestion: use ${ALERT_MIN_INTERVAL_MINUTES} to ${INTERVAL_EVERY_MINUTES_MAX}. A routine you suggest on your own checks every 2 hours or less often.`, hint: "Use a longer interval, or a cron with a few fixed times." };
			}
			if (args.timezone !== undefined && !isValidTimezone(args.timezone)) return { ok: false, error: `timezone "${args.timezone.slice(0, 60)}" is not an IANA timezone.`, hint: 'Use a name like "America/Sao_Paulo".' };
			const outcome = await routines.suggest(
				ctx.ownerId,
				{ name: args.name, task: args.task, trigger: args.cron !== undefined ? { kind: "cron", schedule: args.cron } : { kind: "interval", everyMinutes: args.everyMinutes! }, ...(args.timezone && { timezone: args.timezone }) },
				{ runId: ctx.runId },
			);
			switch (outcome.status) {
				case "duplicate_routine":
					return { ok: false, error: `A similar routine already exists: "${outcome.routine}".`, hint: "Do not suggest it again." };
				case "already_proposed":
					return { ok: false, error: `This routine was already offered to the owner (${outcome.proposal}).`, hint: "Do not offer it again." };
				case "created":
					return { ok: true, summary: `The routine "${args.name}" was created and a card tells the owner (with an Undo button). Mention it in one sentence.`, receipt: { what: `Routine created (suggestion): ${args.name}`, where: "Routines" } };
				case "proposed":
					return { ok: true, summary: `A card now asks the owner whether to create "${args.name}" (Create / Not now). Nothing exists yet. Mention the idea in one sentence; do not insist.`, receipt: { what: `Routine suggested: ${args.name}`, where: "Routines" } };
			}
		},
	});
}
