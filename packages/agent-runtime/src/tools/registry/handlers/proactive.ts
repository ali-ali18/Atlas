import type { ToolContext, ToolResult } from "../types.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";

import { executeProactiveTool, executeUserPush } from "../../proactive.js";

import type { ToolFamily } from "../registry.js";
import { defineRawTool, definedFamily, type DefinedTool } from "../../define-tool.js";
import { SCHEDULE_FOLLOWUP_TOOL, LIST_FOLLOWUPS_TOOL, CANCEL_FOLLOWUP_TOOL, RESCHEDULE_FOLLOWUP_TOOL, SUGGEST_ROUTINE_TOOL, NOTIFY_USER_TOOL } from "../../proactive.js";

async function handleScheduleFollowupGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	// Só `notify_user` vira push avulso. No chat do bot principal o contexto proativo e o de push coexistem:
	// desviar as outras tools para o push quebrava follow-ups e sugestões de rotina (pediam "message").
	if (name === "notify_user" && ctx.userPush) return executeUserPush(args, ctx.userPush);
	if (!ctx.proactive) throw new Error("Modo proativo desligado neste bot.");
	return executeProactiveTool(name, args, ctx.proactive);
}

/** Família `proactive`: definição, metadado e handler de cada tool num lugar só (`defineRawTool`, harness v3 PR5b). */
export const PROACTIVE_DEFINED: readonly DefinedTool[] = [
	defineRawTool({
		name: "schedule_followup",
		definition: SCHEDULE_FOLLOWUP_TOOL,
		effect: "write_internal",
		group: "proactive",
		run: (args, ctx) => handleScheduleFollowupGroup("schedule_followup", args, ctx),
	}),
	defineRawTool({
		name: "list_followups",
		definition: LIST_FOLLOWUPS_TOOL,
		effect: "read",
		group: "proactive",
		run: (args, ctx) => handleScheduleFollowupGroup("list_followups", args, ctx),
	}),
	defineRawTool({
		name: "cancel_followup",
		definition: CANCEL_FOLLOWUP_TOOL,
		effect: "write_internal",
		group: "proactive",
		run: (args, ctx) => handleScheduleFollowupGroup("cancel_followup", args, ctx),
	}),
	defineRawTool({
		name: "reschedule_followup",
		definition: RESCHEDULE_FOLLOWUP_TOOL,
		effect: "write_internal",
		group: "proactive",
		run: (args, ctx) => handleScheduleFollowupGroup("reschedule_followup", args, ctx),
	}),
	defineRawTool({
		name: "suggest_routine",
		definition: SUGGEST_ROUTINE_TOOL,
		effect: "write_internal",
		group: "proactive",
		run: (args, ctx) => handleScheduleFollowupGroup("suggest_routine", args, ctx),
	}),
	// O destino é o próprio dono (push/aviso no app dele), não um terceiro: `write_internal` deixa a rotina avisar o dono.
	defineRawTool({
		name: "notify_user",
		definition: NOTIFY_USER_TOOL,
		effect: "write_internal",
		group: "proactive",
		run: (args, ctx) => handleScheduleFollowupGroup("notify_user", args, ctx),
	}),
];

export const PROACTIVE_TOOLS: ToolFamily = definedFamily(PROACTIVE_DEFINED);
