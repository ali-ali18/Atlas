// Capacidade lazy `routines` (F9, parte 1): ler e controlar as rotinas do produto (a tabela `routines`, as mesmas da Biblioteca).
// NÃO é a `agenda` do v4 (lembretes e vigias do próprio motor). Criar, propor e editar rotina, gatilhos, alerta com veredito e
// webhook ficam para a parte 2. Uma tool por arquivo.
//  - `routine_list`    leitura privada (sempre);
//  - `routine_control` pausar, retomar, apagar (apagar = `destructive`: o dono confirma);
//  - `routine_group`   criar, renomear, desfazer, pausar/retomar grupo, mover rotina.
// Sem dono presente (rotina, agenda, subagente) só `routine_list`.
import type { Routines } from "../../ports/routines.js";
import type { Tool } from "../../tools/define-tool.js";
import { defineCapability } from "../define-capability.js";
import { createRoutineControlTool } from "./routine-control.js";
import { createRoutineGroupTool } from "./routine-group.js";
import { createRoutineListTool } from "./routine-list.js";

export * from "./resolve.js";
export * from "./routine-control.js";
export * from "./routine-group.js";
export * from "./routine-list.js";

export type RoutinesDeps = {
	routines: Routines;
	/** Sem dono presente: só `routine_list`. */
	readOnly?: boolean;
	extraTools?: readonly Tool[];
};

export const ROUTINES_INSTRUCTIONS =
	"Routine rules: routines are the owner's saved tasks and alerts in the Library, not your own reminders (agenda). Read with routine_list before changing anything, and say names, never ids. " +
	"routine_control pauses, resumes or deletes one routine; delete asks the owner first, so only delete when the owner clearly asked (otherwise pause). " +
	"routine_group organizes groups (create, rename, undo, pause or resume the whole group, move a routine). Creating or editing what a routine does or when it runs is not available here yet: say so plainly. " +
	"Say \"routine\", \"alert\" and \"group\" to the owner, never tool names.";

export const ROUTINES_READ_INSTRUCTIONS =
	"Routine rules: routine_list shows the owner's routines and alerts. This run has no owner present, so you cannot pause, resume, delete or organize them here. Say names, never ids.";

export function createRoutinesCapability(deps: RoutinesDeps) {
	const tools = deps.readOnly
		? [createRoutineListTool(deps.routines)]
		: [createRoutineListTool(deps.routines), createRoutineControlTool(deps.routines), createRoutineGroupTool(deps.routines), ...(deps.extraTools ?? [])];
	return defineCapability({
		id: "routines",
		title: "Rotinas",
		summary: "The owner's routines and alerts (Library): list them, pause, resume or delete one, organize groups. Not your own reminders.",
		tools,
		instructions: deps.readOnly ? ROUTINES_READ_INSTRUCTIONS : ROUTINES_INSTRUCTIONS,
		cards: ["routine"],
	});
}
