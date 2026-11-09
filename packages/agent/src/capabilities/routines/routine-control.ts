// `routine_control`: pausar, retomar ou apagar UMA rotina existente (o que o dono faz no cartão da rotina). Pausar e retomar são
// `write_internal` (voltam); apagar é `destructive`, então o dono confirma no cartão em qualquer autonomia e, sem dono, a
// tool nem existe. O adaptador mostra o cartão da rotina no chat.
import { z } from "zod";
import type { Routines } from "../../ports/routines.js";
import { defineTool } from "../../tools/define-tool.js";
import { findRoutine, optionsLine } from "./resolve.js";

export const ROUTINE_CONTROL_ACTIONS = ["pause", "resume", "delete"] as const;

export function createRoutineControlTool(routines: Routines) {
	return defineTool({
		name: "routine_control",
		description:
			"Pause, resume or delete ONE existing routine or alert, by name or id from routine_list. pause stops the schedule and keeps everything; resume starts it again; delete removes it for good and the owner confirms first. " +
			"Use it for \"pausa o alerta do estoque\", \"volta com a rotina X\", \"apaga a rotina Y\". Delete only when the owner clearly asked to delete (to just stop it, pause). " +
			"Not for changing what a routine does or when it runs, and not for groups (routine_group).",
		inputSchema: z.object({
			action: z.enum(ROUTINE_CONTROL_ACTIONS),
			target: z.string().trim().min(1).max(200).describe("Routine name or id from routine_list."),
		}),
		effect: "write_internal",
		effectForArgs: ({ action }) => (action === "delete" ? "destructive" : "write_internal"),
		riskFacts: ({ action, target }) => (action === "delete" ? { irreversible: true, target } : {}),
		async enrichRiskFacts({ action, target }, base, { ownerId }) {
			if (action !== "delete") return base;
			const found = findRoutine(await routines.list(ownerId), target);
			return found.kind === "one" ? { ...base, target: `${found.item.name} (${found.item.trigger})` } : base;
		},
		async execute({ action, target }, ctx) {
			const found = findRoutine(await routines.list(ctx.ownerId), target);
			if (found.kind === "none") return { ok: false, error: `No routine matches "${target.slice(0, 80)}".`, hint: "Call routine_list for the names." };
			if (found.kind === "ambiguous") return { ok: false, error: `More than one routine matches "${target.slice(0, 80)}": ${optionsLine(found.items)}.`, hint: "Ask the owner which one, or call again with the exact name or id." };
			const routine = found.item;
			const label = routine.alert ? "Alert" : "Routine";

			if (action === "delete") {
				const removed = await routines.remove(ctx.ownerId, routine.id);
				if (!removed) return { ok: false, error: `No routine matches "${target.slice(0, 80)}".`, hint: "It may have been deleted already. Call routine_list." };
				return { ok: true, summary: `${label} "${routine.name}" deleted for good.`, receipt: { what: `${label} deleted: ${routine.name}`, where: "Routines", externalId: routine.id } };
			}

			const enabled = action === "resume";
			if (routine.enabled === enabled) return { ok: true, summary: `"${routine.name}" is already ${enabled ? "active" : "paused"}. Nothing changed.`, receipt: { what: `${label} already ${enabled ? "active" : "paused"} (nothing changed): ${routine.name}`, where: "Routines", externalId: routine.id } };
			const updated = await routines.setEnabled(ctx.ownerId, routine.id, enabled);
			if (!updated) return { ok: false, error: `No routine matches "${target.slice(0, 80)}".`, hint: "It may have been deleted. Call routine_list." };
			return { ok: true, summary: `${label} "${updated.name}" ${enabled ? "resumed" : "paused"}.`, receipt: { what: `${label} ${enabled ? "resumed" : "paused"}: ${updated.name}`, where: "Routines", externalId: updated.id } };
		},
	});
}
