// `routine_create`: cria uma rotina da Biblioteca (o que o legado fazia com `propose_routine` action=create). O gatilho é validado de
// verdade (cron, uma vez, intervalo, e-mail, GitHub, webhook); o alerta por intervalo respeita o mínimo de 2 h; a permissão de login
// é um campo DECLARADO pelo modelo e só vale depois do cartão de aprovação do dono (efeito `credential`). Criar não tem cartão de
// proposta (como no legado): a rotina nasce e o cartão da rotina aparece. Sem dono presente a tool nem existe.
import { z } from "zod";
import type { Routines } from "../../ports/routines.js";
import type { Vault } from "../../ports/vault.js";
import { defineTool } from "../../tools/define-tool.js";
import { findRoutine } from "./resolve.js";
import { alertField, alertSpecOf, checkLoginAccess, loginAccessField, loginAccessTarget, NOTIFY_MODES } from "./routine-save.js";
import { alertNeedsTimeTrigger, isValidTimezone, planTrigger, triggerFields } from "./routine-trigger.js";

export const DEFAULT_ROUTINE_TIMEZONE = "America/Sao_Paulo";

export function createRoutineCreateTool(deps: { routines: Routines; vault?: Pick<Vault, "listHandles"> | undefined }) {
	const { routines, vault } = deps;
	return defineTool({
		name: "routine_create",
		description:
			"Create ONE routine (or alert) for the owner: something you do on a schedule or when an event happens. name = short title; task = the instruction you will follow on each run, self-contained (what to check, which tools, what to deliver); then the trigger (triggerType and its fields). " +
			"Alert by condition (\"avisa se o estoque cair abaixo de 10\"): pass alert with a cron or interval trigger; each run only checks and the owner is told only when the condition newly becomes true. Checks cost a model run, so prefer few check times (cron on weekdays) and an interval of 2 hours or more unless the owner explicitly asked for more often (then alert.frequent=true). " +
			"group = a group name of the Library (reused if it exists). panelId = a panel of this bot that each run refreshes in place (from panel_list), write in task how to rebuild it with fresh data. notify important = the run is saved quietly and only warns when something deserves attention. " +
			"If the routine will need to sign in to a site, declare loginAccess { login, site }: the owner approves that login on that site once, and only then can the routine sign in (it cannot otherwise). " +
			"Use it when the owner asks to schedule, monitor or automate something. Do not use it for a one-off reminder to yourself (remind_me), to change an existing routine (routine_update), inside a routine run, or for a task to do now. The owner sees the routine card: confirm in one plain sentence what it does and when.",
		inputSchema: z.object({
			name: z.string().trim().min(1).max(120),
			task: z.string().trim().min(1).max(4000),
			...triggerFields,
			timezone: z.string().trim().min(1).max(64).optional().describe(`IANA timezone (default ${DEFAULT_ROUTINE_TIMEZONE}); also reads runAt without an offset.`),
			group: z.string().trim().min(1).max(80).optional(),
			panelId: z.string().trim().min(1).max(64).optional(),
			notify: z.enum(NOTIFY_MODES).optional(),
			alert: alertField.optional(),
			loginAccess: loginAccessField.optional(),
			enabled: z.boolean().optional().describe("Default true."),
		}),
		// Declarar o login faz o dono aprovar (cartão em qualquer autonomia); sem isso é uma escrita interna que desfaz.
		effect: "write_internal",
		effectForArgs: (args) => (args.loginAccess ? "credential" : "write_internal"),
		riskFacts: (args) => ({ target: args.loginAccess ? loginAccessTarget({ login: args.loginAccess.login, site: args.loginAccess.site }) : `routine ${args.name}` }),
		async execute(args, ctx) {
			const now = ctx.ports.clock.now();
			const timezone = args.timezone ?? DEFAULT_ROUTINE_TIMEZONE;
			if (!isValidTimezone(timezone)) return { ok: false, error: `timezone "${timezone.slice(0, 60)}" is not an IANA timezone.`, hint: 'Use a name like "America/Sao_Paulo".' };
			const planned = planTrigger(args, { now, timezone, ...(args.alert && { alert: { frequent: args.alert.frequent } }) });
			if (!planned.ok) return planned;
			if (args.alert) {
				const bad = alertNeedsTimeTrigger(planned.trigger);
				if (bad) return { ok: false, error: bad, hint: "Change triggerType or drop the alert." };
			}
			// Mesmo nome = é uma edição, não outra rotina: o modelo decide (nada de duplicar nem de editar às escondidas).
			const same = findRoutine(await routines.list(ctx.ownerId), args.name);
			if (same.kind === "one" && same.item.name.trim().toLowerCase() === args.name.trim().toLowerCase()) {
				return { ok: false, error: `A routine named "${same.item.name}" already exists.`, hint: `Use routine_update with target "${same.item.id}" to change it, or pick another name.` };
			}
			let loginAccess;
			if (args.loginAccess) {
				const checked = await checkLoginAccess(args.loginAccess, ctx.ownerId, vault);
				if (!checked.ok) return checked;
				loginAccess = checked.access;
			}
			const saved = await routines.create(ctx.ownerId, {
				name: args.name,
				task: args.task,
				trigger: planned.trigger,
				timezone,
				enabled: args.enabled ?? true,
				...(args.group && { group: args.group }),
				...(args.panelId && { panelId: args.panelId }),
				...(args.notify && { notify: args.notify }),
				...(args.alert && { alert: alertSpecOf(args.alert) }),
				...(loginAccess && { loginAccess }),
			});
			const { routine } = saved;
			const kind = routine.alert ? "Alert" : "Routine";
			const webhook = saved.webhook
				? ` Webhook address (no secret): ${saved.webhook.url}. The secret is not shown here: the owner copies it from the routine in the Library ("Gerar novo segredo"). Never invent a secret or a URL.`
				: "";
			const login = routine.loginAccess ? ` It may sign in to ${routine.loginAccess.site} with the login "${routine.loginAccess.login}" (approved), nowhere else.` : "";
			const state = routine.enabled ? "" : " It is paused.";
			return {
				ok: true,
				summary: `${kind} "${routine.name}" created: ${routine.alert ?? routine.trigger}.${state}${login}${webhook} The routine card is already shown to the owner: confirm in one plain sentence what it does and when, do not repeat the card.`,
				receipt: { what: `${kind} created: ${routine.name}`, where: "Routines", externalId: routine.id },
			};
		},
	});
}
