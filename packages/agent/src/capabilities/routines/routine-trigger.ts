// Validação do gatilho de uma rotina (F9 parte 2). PURA: recebe o que o modelo declarou e devolve o gatilho tipado (`RoutineTriggerSpec`)
// ou um erro com a lista do que é aceito. Reaproveita os validadores de `@workspace/shared` (os mesmos do legado e da API):
// cron de 5 campos, uma vez (`run_at` ou `in_minutes`), intervalo de 5 a 1440 min, e-mail (filtros), GitHub (repo + eventos).
// Regra de produto: alerta por intervalo só confere a cada 2 h ou mais, salvo pedido EXPLÍCITO do dono (`alert.frequent`).
import { GITHUB_TRIGGER_EVENTS, INTERVAL_EVERY_MINUTES_MAX, INTERVAL_EVERY_MINUTES_MIN, parseEmailTriggerInput, parseGithubTriggerInput, parseIntervalEveryMinutes, resolveOnceRunAt, validateAlertInterval, validateCronExpression } from "@workspace/shared";
import { z } from "zod";
import type { RoutineTriggerSpec } from "../../ports/routines.js";

export const ROUTINE_TRIGGER_TYPES = ["cron", "once", "interval", "email", "github", "webhook"] as const;
export type RoutineTriggerKind = (typeof ROUTINE_TRIGGER_TYPES)[number];

/** Campos do gatilho no schema das duas tools (`routine_create` e `routine_update`): os mesmos nomes, descrições curtas. */
export const triggerFields = {
	triggerType: z.enum(ROUTINE_TRIGGER_TYPES).describe("cron = fixed clock times (needs schedule); once = a single time (needs runAt or inMinutes); interval = every N minutes counted from the last run (needs everyMinutes); email = when an e-mail arrives in the bot's own inbox; github = instant GitHub webhook (needs github); webhook = generic URL the owner wires to another system."),
	schedule: z.string().trim().max(120).optional().describe('cron only: 5 fields, like "0 9 * * 1-5".'),
	runAt: z.string().trim().max(60).optional().describe("once only: ISO 8601 date and time, like 2026-10-03T10:00. No offset = the routine's timezone. Must be in the future, at most 1 year ahead. Use runAt OR inMinutes."),
	inMinutes: z.number().int().min(1).max(10080).optional().describe('once only: fire N minutes from now ("in 2 hours" = 120). Use runAt OR inMinutes.'),
	everyMinutes: z.number().int().optional().describe(`interval only: ${INTERVAL_EVERY_MINUTES_MIN} to ${INTERVAL_EVERY_MINUTES_MAX}.`),
	email: z.strictObject({ fromContains: z.string().trim().max(200).optional(), subjectContains: z.string().trim().max(200).optional() }).optional().describe("email only: optional case-insensitive filters. Omit both for every e-mail from an allowed sender."),
	github: z
		.strictObject({
			repo: z.string().trim().min(1).max(200).describe("owner/name (a GitHub URL also works)."),
			events: z.array(z.enum(GITHUB_TRIGGER_EVENTS)).min(1).max(GITHUB_TRIGGER_EVENTS.length),
			prNumber: z.number().int().min(1).optional().describe("Watch one pull request only."),
			users: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe("Only events by these logins."),
			branch: z.string().trim().min(1).max(200).optional().describe("push: branch pushed; pr_*: target branch; ci_*: required branch of the check."),
		})
		.optional()
		.describe("github only."),
};

export type TriggerArgs = {
	triggerType: RoutineTriggerKind;
	schedule?: string | undefined;
	runAt?: string | undefined;
	inMinutes?: number | undefined;
	everyMinutes?: number | undefined;
	email?: { fromContains?: string | undefined; subjectContains?: string | undefined } | undefined;
	github?: { repo: string; events: string[]; prNumber?: number | undefined; users?: string[] | undefined; branch?: string | undefined } | undefined;
};

export type TriggerPlan = { ok: true; trigger: RoutineTriggerSpec } | { ok: false; error: string; hint: string };

const fail = (error: string, hint: string): { ok: false; error: string; hint: string } => ({ ok: false, error, hint });

/** Quais campos de gatilho valem para cada tipo; um campo de outro tipo falha em vez de ser ignorado em silêncio. */
const FIELDS_OF: Readonly<Record<RoutineTriggerKind, readonly (keyof TriggerArgs)[]>> = {
	cron: ["schedule"],
	once: ["runAt", "inMinutes"],
	interval: ["everyMinutes"],
	email: ["email"],
	github: ["github"],
	webhook: [],
};
const ALL_FIELDS = ["schedule", "runAt", "inMinutes", "everyMinutes", "email", "github"] as const;

/** Fuso IANA válido? (sem isso o agendador gravaria um fuso que ninguém entende) */
export function isValidTimezone(timezone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}

/** O gatilho que o modelo descreveu, validado. `alert` só entra para aplicar o mínimo de 2 h do alerta por intervalo. */
export function planTrigger(args: TriggerArgs, ctx: { now: Date; timezone: string; alert?: { frequent?: boolean | undefined } | undefined }): TriggerPlan {
	const kind = args.triggerType;
	const stray = ALL_FIELDS.filter((field) => args[field] !== undefined && !FIELDS_OF[kind].includes(field));
	if (stray.length > 0) {
		return fail(`${stray.join(", ")} does not belong to triggerType ${kind}.`, FIELDS_OF[kind].length > 0 ? `For ${kind} pass only: ${FIELDS_OF[kind].join(", ")}.` : `A ${kind} trigger takes no extra fields.`);
	}
	switch (kind) {
		case "cron": {
			if (!args.schedule) return fail("cron needs schedule.", 'Pass 5 cron fields, like "0 9 * * 1-5".');
			const cron = validateCronExpression(args.schedule);
			if (!cron.ok) return fail(`schedule "${args.schedule.slice(0, 60)}" is not a valid cron: ${cron.reason}`, 'Use 5 fields (minute hour day month weekday) with numbers, like "0 9 * * 1-5".');
			return { ok: true, trigger: { kind: "cron", schedule: args.schedule } };
		}
		case "once": {
			const resolved = resolveOnceRunAt({ runAt: args.runAt, inMinutes: args.inMinutes, timezone: ctx.timezone }, ctx.now);
			if (!resolved.ok) return fail(resolved.error, "Pass runAt (a future date and time) OR inMinutes, not both. One time per routine: for several times create one routine each.");
			return { ok: true, trigger: { kind: "once", runAt: resolved.runAtIso } };
		}
		case "interval": {
			const parsed = parseIntervalEveryMinutes({ everyMinutes: args.everyMinutes });
			if (!parsed.ok) return fail(parsed.error, `Pass everyMinutes as a whole number from ${INTERVAL_EVERY_MINUTES_MIN} to ${INTERVAL_EVERY_MINUTES_MAX}.`);
			if (ctx.alert) {
				const tooOften = validateAlertInterval(parsed.everyMinutes, ctx.alert.frequent === true);
				if (tooOften) return fail(tooOften, "Use cron with a few check times, everyMinutes of 120 or more, or alert.frequent=true only if the owner explicitly asked for that frequency.");
			}
			return { ok: true, trigger: { kind: "interval", everyMinutes: parsed.everyMinutes } };
		}
		case "email": {
			const parsed = parseEmailTriggerInput(args.email ?? {});
			if ("error" in parsed) return fail(parsed.error, "Filters are optional; omit them to match every e-mail from an allowed sender.");
			return { ok: true, trigger: { kind: "email", ...parsed.value } };
		}
		case "github": {
			if (!args.github) return fail("github needs the github object (repo and events).", "Pass github: { repo: \"owner/name\", events: [...] }.");
			const parsed = parseGithubTriggerInput({ repo: args.github.repo, events: args.github.events, prNumber: args.github.prNumber, users: args.github.users, branch: args.github.branch });
			if ("error" in parsed) return fail(parsed.error, `events accepted: ${GITHUB_TRIGGER_EVENTS.join(", ")}.`);
			const { repo, events, prNumber, users, branch } = parsed.value;
			return { ok: true, trigger: { kind: "github", repo, events, ...(prNumber !== undefined && { prNumber }), ...(users && users.length > 0 && { users }), ...(branch && { branch }) } };
		}
		case "webhook":
			return { ok: true, trigger: { kind: "webhook" } };
	}
}

/** Alerta só combina com gatilho por tempo (cron ou intervalo): o worker confere "de tempos em tempos". */
export function alertNeedsTimeTrigger(trigger: RoutineTriggerSpec): string | null {
	return trigger.kind === "cron" || trigger.kind === "interval" ? null : "An alert checks on a schedule, so it only works with triggerType cron or interval. For a one-off reminder use once; for instant events use github or email without alert.";
}
