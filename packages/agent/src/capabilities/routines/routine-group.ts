// `routine_group`: grupos da Biblioteca (valem para rotinas e painéis). Criar, renomear, desfazer, pausar/retomar o grupo todo
// e mover uma rotina de grupo. Tudo `write_internal` (volta com outra chamada; desfazer o grupo não apaga as rotinas).
import { z } from "zod";
import type { RoutineGroupView, Routines } from "../../ports/routines.js";
import { defineTool } from "../../tools/define-tool.js";
import { findGroup, findRoutine, optionsLine, type Found } from "./resolve.js";

export const ROUTINE_GROUP_ACTIONS = ["create", "rename", "delete", "pause", "resume", "move", "ungroup"] as const;
type Action = (typeof ROUTINE_GROUP_ACTIONS)[number];

const MAX_NAME = 80;

const fail = (error: string, hint: string) => ({ ok: false as const, error, hint });
const NEEDS: Readonly<Record<Action, string>> = {
	create: "group (the new group name)",
	rename: "group (current name or id) and newName",
	delete: "group (name or id)",
	pause: "group (name or id)",
	resume: "group (name or id)",
	move: "routine (name or id) and group (name or id)",
	ungroup: "routine (name or id)",
};

export function createRoutineGroupTool(routines: Routines) {
	return defineTool({
		name: "routine_group",
		description:
			"Manage the Library groups of routines (the same groups hold panels). action: create (group = new name), rename (group, newName), delete (group; the routines stay, ungrouped), pause or resume (every routine in the group), " +
			"move (routine, group: put a routine in an existing group), ungroup (routine: take it out of its group). Names or ids come from routine_list. " +
			"Use it when the owner asks to organize, rename, or pause a whole group. Not for pausing, resuming or deleting a single routine (routine_control).",
		inputSchema: z.object({
			action: z.enum(ROUTINE_GROUP_ACTIONS),
			group: z.string().trim().min(1).max(200).optional().describe("Group name or id (the new name for create)."),
			newName: z.string().trim().min(1).max(MAX_NAME).optional().describe("rename only: the new group name."),
			routine: z.string().trim().min(1).max(200).optional().describe("move and ungroup only: routine name or id."),
		}),
		effect: "write_internal",
		async execute({ action, group, newName, routine }, ctx) {
			const missing = () => fail(`${action} is missing a required field.`, `Pass ${NEEDS[action]}.`);
			const groupNotFound = (found: Found<RoutineGroupView>, query: string, all: readonly RoutineGroupView[]) =>
				found.kind === "ambiguous"
					? fail(`More than one group matches "${query.slice(0, 80)}": ${optionsLine(found.items)}.`, "Ask the owner which one, or pass the exact name or id.")
					: fail(`No group matches "${query.slice(0, 80)}".`, all.length > 0 ? `Groups: ${optionsLine(all)}. To make a new one use action create.` : "There are no groups yet. To make one use action create.");

			if (action === "create") {
				if (!group) return missing();
				const created = await routines.createGroup(ctx.ownerId, group);
				return { ok: true, summary: `Group "${created.name}" created (empty). Move routines into it with action move.`, receipt: { what: `Routine group created: ${created.name}`, where: "Routines", externalId: created.id } };
			}

			if (action === "move" || action === "ungroup") {
				if (!routine) return missing();
				if (action === "move" && !group) return missing();
				const found = findRoutine(await routines.list(ctx.ownerId), routine);
				if (found.kind === "none") return fail(`No routine matches "${routine.slice(0, 80)}".`, "Call routine_list for the names.");
				if (found.kind === "ambiguous") return fail(`More than one routine matches "${routine.slice(0, 80)}": ${optionsLine(found.items)}.`, "Ask the owner which one, or pass the exact name or id.");
				let target: RoutineGroupView | null = null;
				if (action === "move") {
					const all = await routines.groups(ctx.ownerId);
					const g = findGroup(all, group!);
					if (g.kind !== "one") return groupNotFound(g, group!, all);
					target = g.item;
				}
				const moved = await routines.moveToGroup(ctx.ownerId, found.item.id, target?.id ?? null);
				if (!moved) return fail("The routine or the group no longer exists.", "Call routine_list and try again.");
				return {
					ok: true,
					summary: target ? `"${moved.name}" is now in the group "${target.name}".` : `"${moved.name}" is out of its group.`,
					receipt: { what: target ? `Routine moved to group ${target.name}: ${moved.name}` : `Routine taken out of its group: ${moved.name}`, where: "Routines", externalId: moved.id },
				};
			}

			if (!group) return missing();
			const all = await routines.groups(ctx.ownerId);
			const g = findGroup(all, group);
			if (g.kind !== "one") return groupNotFound(g, group, all);
			const current = g.item;

			if (action === "rename") {
				if (!newName) return missing();
				const renamed = await routines.renameGroup(ctx.ownerId, current.id, newName);
				if (!renamed) return fail(`No group matches "${group.slice(0, 80)}".`, "Call routine_list.");
				return { ok: true, summary: `Group "${current.name}" renamed to "${renamed.name}". Its routines and panels stay in it.`, receipt: { what: `Routine group renamed: ${current.name} to ${renamed.name}`, where: "Routines", externalId: renamed.id } };
			}
			if (action === "delete") {
				const removed = await routines.deleteGroup(ctx.ownerId, current.id);
				if (!removed) return fail(`No group matches "${group.slice(0, 80)}".`, "Call routine_list.");
				return { ok: true, summary: `Group "${removed.name}" undone. Its ${removed.routines} routine${removed.routines === 1 ? "" : "s"} stay, without a group.`, receipt: { what: `Routine group removed: ${removed.name}`, where: "Routines", externalId: current.id } };
			}
			const enabled = action === "resume";
			const result = await routines.setGroupEnabled(ctx.ownerId, current.id, enabled);
			if (!result) return fail(`No group matches "${group.slice(0, 80)}".`, "Call routine_list.");
			return {
				ok: true,
				summary: `Group "${result.name}": ${result.total} routine${result.total === 1 ? "" : "s"}, ${result.changed} ${enabled ? "resumed" : "paused"}${result.changed < result.total ? " (the rest already were)" : ""}.`,
				receipt: { what: `Routine group ${enabled ? "resumed" : "paused"}: ${result.name}`, where: "Routines", externalId: current.id },
			};
		},
	});
}
