// `routine_update`: edita UMA rotina existente (nome, instrução, gatilho, grupo, painel, aviso, alerta, permissão de login, ligar ou
// pausar). O gatilho, quando muda, vem COMPLETO e passa pela mesma validação do `routine_create`. A permissão de login nova
// exige o cartão de aprovação do dono (efeito `credential`); tirar a permissão não pede. O adaptador sincroniza o agendador e o
// webhook do GitHub, e o cartão da rotina (mesma identidade `routineId`) é atualizado. Sem dono presente a tool nem existe.
import { z } from "zod";
import type { RoutineUpdateSpec, Routines } from "../../ports/routines.js";
import type { Vault } from "../../ports/vault.js";
import { defineTool } from "../../tools/define-tool.js";
import { findRoutine, optionsLine } from "./resolve.js";
import { alertField, alertSpecOf, checkLoginAccess, loginAccessField, loginAccessTarget, NOTIFY_MODES } from "./routine-save.js";
import { alertNeedsTimeTrigger, isValidTimezone, planTrigger, triggerFields, type TriggerArgs } from "./routine-trigger.js";

const TRIGGER_KEYS = ["schedule", "runAt", "inMinutes", "everyMinutes", "email", "github"] as const;

export function createRoutineUpdateTool(deps: { routines: Routines; vault?: Pick<Vault, "listHandles"> | undefined; defaultTimezone?: string }) {
	const { routines, vault } = deps;
	return defineTool({
		name: "routine_update",
		description:
			"Change ONE existing routine or alert, by name or id from routine_list: name, task (the instruction), the trigger, group, panelId, notify, alert, loginAccess, timezone, or enabled (false pauses, true resumes). Pass only what changes; the rest stays. " +
			"To change WHEN it runs, pass triggerType with ALL the fields of that trigger (the same as routine_create), even if the type stays the same. group: empty string takes it out of its group. panelId: empty string detaches the panel. alert: null turns an alert back into a normal routine. loginAccess: a new login permission asks the owner to approve; null removes it. " +
			"Use it when the owner asks to change, move, rename or re-time a routine. Do not use it to just pause, resume or delete (routine_control), to move between groups without other changes (routine_group), to create one (routine_create), or inside a routine run.",
		inputSchema: z.object({
			target: z.string().trim().min(1).max(200).describe("Routine name or id from routine_list."),
			name: z.string().trim().min(1).max(120).optional(),
			task: z.string().trim().min(1).max(4000).optional(),
			...triggerFields,
			triggerType: triggerFields.triggerType.optional(),
			timezone: z.string().trim().min(1).max(64).optional(),
			group: z.string().trim().max(80).optional(),
			panelId: z.string().trim().max(64).optional(),
			notify: z.enum(NOTIFY_MODES).optional(),
			alert: alertField.nullable().optional(),
			loginAccess: loginAccessField.nullable().optional(),
			enabled: z.boolean().optional(),
		}),
		effect: "write_internal",
		effectForArgs: (args) => (args.loginAccess ? "credential" : "write_internal"),
		riskFacts: (args) => ({ target: args.loginAccess ? loginAccessTarget({ login: args.loginAccess.login, site: args.loginAccess.site }) : `routine ${args.target}` }),
		async execute(args, ctx) {
			const { target, ...changes } = args;
			const found = findRoutine(await routines.list(ctx.ownerId), target);
			if (found.kind === "none") return { ok: false, error: `No routine matches "${target.slice(0, 80)}".`, hint: "Call routine_list for the names." };
			if (found.kind === "ambiguous") return { ok: false, error: `More than one routine matches "${target.slice(0, 80)}": ${optionsLine(found.items)}.`, hint: "Ask the owner which one, or call again with the exact name or id." };
			const current = found.item;
			const spec: RoutineUpdateSpec = {};

			const timezone = changes.timezone;
			if (timezone !== undefined) {
				if (!isValidTimezone(timezone)) return { ok: false, error: `timezone "${timezone.slice(0, 60)}" is not an IANA timezone.`, hint: 'Use a name like "America/Sao_Paulo".' };
				spec.timezone = timezone;
			}

			let triggerKind: "cron" | "interval" | undefined = current.kind === "cron" || current.kind === "interval" ? current.kind : undefined;
			if (changes.triggerType === undefined) {
				const stray = TRIGGER_KEYS.filter((key) => changes[key] !== undefined);
				if (stray.length > 0) return { ok: false, error: `${stray.join(", ")} given without triggerType.`, hint: "To change the trigger pass triggerType and all the fields of that trigger." };
			} else {
				const planned = planTrigger({ ...(changes as TriggerArgs), triggerType: changes.triggerType }, { now: ctx.ports.clock.now(), timezone: timezone ?? deps.defaultTimezone ?? "America/Sao_Paulo", ...(changes.alert && { alert: { frequent: changes.alert.frequent } }) });
				if (!planned.ok) return planned;
				spec.trigger = planned.trigger;
				triggerKind = planned.trigger.kind === "cron" || planned.trigger.kind === "interval" ? planned.trigger.kind : undefined;
				// Rotina com alerta que sai de cron/intervalo perde o sentido de conferir de tempos em tempos.
				if (current.alert && changes.alert === undefined && alertNeedsTimeTrigger(planned.trigger)) {
					return { ok: false, error: "This alert checks on a schedule, so its trigger must stay cron or interval.", hint: "Pass alert: null to turn it back into a normal routine while changing the trigger." };
				}
			}

			if (changes.alert === null) spec.alert = null;
			else if (changes.alert) {
				if (triggerKind === undefined) return { ok: false, error: "An alert checks on a schedule, so the routine needs a cron or interval trigger.", hint: "Pass triggerType cron or interval (with its fields) together with the alert." };
				spec.alert = alertSpecOf(changes.alert);
			}

			if (changes.loginAccess === null) spec.loginAccess = null;
			else if (changes.loginAccess) {
				const checked = await checkLoginAccess(changes.loginAccess, ctx.ownerId, vault);
				if (!checked.ok) return checked;
				spec.loginAccess = checked.access;
			}

			if (changes.name !== undefined) {
				const clash = (await routines.list(ctx.ownerId)).find((r) => r.id !== current.id && r.name.trim().toLowerCase() === changes.name!.trim().toLowerCase());
				if (clash) return { ok: false, error: `Another routine is already named "${clash.name}".`, hint: "Pick a different name." };
				spec.name = changes.name;
			}
			if (changes.task !== undefined) spec.task = changes.task;
			if (changes.group !== undefined) spec.group = changes.group;
			if (changes.panelId !== undefined) spec.panelId = changes.panelId;
			if (changes.notify !== undefined) spec.notify = changes.notify;
			if (changes.enabled !== undefined) spec.enabled = changes.enabled;
			if (Object.keys(spec).length === 0) return { ok: false, error: "Nothing to change.", hint: "Pass at least one of: name, task, triggerType (with its fields), timezone, group, panelId, notify, alert, loginAccess, enabled." };

			const saved = await routines.update(ctx.ownerId, current.id, spec);
			if (!saved) return { ok: false, error: `No routine matches "${target.slice(0, 80)}".`, hint: "It may have been deleted. Call routine_list." };
			const { routine } = saved;
			const kind = routine.alert ? "Alert" : "Routine";
			const webhook = saved.webhook ? ` Webhook address (no secret): ${saved.webhook.url}. The secret is not shown here: the owner copies it from the routine in the Library ("Gerar novo segredo").` : "";
			const login = spec.loginAccess && routine.loginAccess ? ` It may sign in to ${routine.loginAccess.site} with the login "${routine.loginAccess.login}" (approved), nowhere else.` : "";
			return {
				ok: true,
				summary: `${kind} "${routine.name}" updated: ${routine.alert ?? routine.trigger}.${routine.enabled ? "" : " It is paused."}${login}${webhook} The routine card was updated: say in one plain sentence what changed.`,
				receipt: { what: `${kind} updated: ${routine.name}`, where: "Routines", externalId: routine.id },
			};
		},
	});
}
