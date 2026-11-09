// Capacidade lazy `routines` (F9): ler, criar, editar e controlar as rotinas do produto (a tabela `routines`, as mesmas da Biblioteca).
// NÃO é a `agenda` do v4 (lembretes e vigias do próprio motor). Uma tool por arquivo.
//  - `routine_list`    leitura privada (sempre);
//  - `routine_create`  cria (gatilho validado, alerta com piso de 2 h, permissão de login declarada = cartão de aprovação);
//  - `routine_update`  edita (mesma validação; sincroniza agendador e webhook do GitHub);
//  - `routine_webhook_info` endereço do webhook das rotinas (nunca o segredo);
//  - `suggest_routine` oferece uma ideia de rotina por cartão (não cria sozinha; só com o modo proativo ligado);
//  - `routine_control` pausar, retomar, apagar (apagar = `destructive`: o dono confirma);
//  - `routine_group`   criar, renomear, desfazer, pausar/retomar grupo, mover rotina.
// Sem dono presente (rotina, agenda, subagente) só `routine_list`.
import type { Routines } from "../../ports/routines.js";
import type { Vault } from "../../ports/vault.js";
import type { Tool } from "../../tools/define-tool.js";
import { defineCapability } from "../define-capability.js";
import { createRoutineControlTool } from "./routine-control.js";
import { createRoutineCreateTool } from "./routine-create.js";
import { createRoutineUpdateTool } from "./routine-update.js";
import { createRoutineGroupTool } from "./routine-group.js";
import { createRoutineListTool } from "./routine-list.js";
import { createRoutineWebhookInfoTool } from "./routine-webhook-info.js";
import { createSuggestRoutineTool } from "./suggest-routine.js";

export * from "./resolve.js";
export * from "./routine-control.js";
export * from "./routine-create.js";
export * from "./routine-save.js";
export * from "./routine-trigger.js";
export * from "./routine-update.js";
export * from "./routine-group.js";
export * from "./routine-list.js";
export * from "./routine-webhook-info.js";
export * from "./report-alert.js";
export * from "./notify-user.js";
export * from "./suggest-routine.js";

export type RoutinesDeps = {
	routines: Routines;
	/** Sem dono presente: só `routine_list`. */
	readOnly?: boolean;
	/** Só nomes e sites do cofre: `routine_create`/`routine_update` conferem a permissão de login declarada contra eles. Sem ele a permissão não é aceita. */
	vault?: Pick<Vault, "listHandles">;
	extraTools?: readonly Tool[];
};

export const ROUTINES_INSTRUCTIONS =
	"Routine rules: routines are the owner's saved tasks and alerts in the Library, not your own reminders (agenda). Read with routine_list before changing anything, and say names, never ids. " +
	"routine_control pauses, resumes or deletes one routine; delete asks the owner first, so only delete when the owner clearly asked (otherwise pause). " +
	"routine_group organizes groups (create, rename, undo, pause or resume the whole group, move a routine). " +
	"routine_create makes a new routine or alert, routine_update changes one (what it does, when it runs, group, panel, warning mode, alert, login permission); read the list first and prefer updating over creating a twin. " +
	"A routine runs later with no owner present, so if it will need to sign in to a site, declare loginAccess (a saved login and its site): the owner approves exactly that, and the routine can sign in nowhere else. An alert checks every 2 hours or more unless the owner explicitly asked for more often. " +
	"Say \"routine\", \"alert\" and \"group\" to the owner, never tool names.";

export const ROUTINES_READ_INSTRUCTIONS =
	"Routine rules: routine_list shows the owner's routines and alerts. This run has no owner present, so you cannot pause, resume, delete or organize them here. Say names, never ids.";

export function createRoutinesCapability(deps: RoutinesDeps) {
	const tools = deps.readOnly
		? [createRoutineListTool(deps.routines)]
		: [createRoutineListTool(deps.routines), createRoutineControlTool(deps.routines), createRoutineGroupTool(deps.routines), createRoutineCreateTool({ routines: deps.routines, vault: deps.vault }), createRoutineUpdateTool({ routines: deps.routines, vault: deps.vault }), createRoutineWebhookInfoTool(deps.routines), createSuggestRoutineTool(deps.routines), ...(deps.extraTools ?? [])];
	return defineCapability({
		id: "routines",
		title: "Rotinas",
		summary: "The owner's routines and alerts (Library): list, create, change, pause, resume or delete them, organize groups. Not your own reminders.",
		tools,
		instructions: deps.readOnly ? ROUTINES_READ_INSTRUCTIONS : ROUTINES_INSTRUCTIONS,
		cards: ["routine"],
	});
}
