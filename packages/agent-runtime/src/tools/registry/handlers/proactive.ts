import type { ToolContext, ToolResult } from "../types.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";

import { executeProactiveTool, executeUserPush } from "../../proactive.js";

import type { ToolFamily } from "../registry.js";

async function handleScheduleFollowupGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	// Só `notify_user` vira push avulso. No chat do bot principal o contexto proativo e o de push coexistem:
	// desviar as outras tools para o push quebrava follow-ups e sugestões de rotina (pediam "message").
	if (name === "notify_user" && ctx.userPush) return executeUserPush(args, ctx.userPush);
	if (!ctx.proactive) throw new Error("Modo proativo desligado neste bot.");
	return executeProactiveTool(name, args, ctx.proactive);
}

/** Família `proactive`. */
export const PROACTIVE_TOOLS: ToolFamily = {
	"schedule_followup": { group: "proactive", handler: (args, ctx) => handleScheduleFollowupGroup("schedule_followup", args, ctx) },
	"list_followups": { group: "proactive", handler: (args, ctx) => handleScheduleFollowupGroup("list_followups", args, ctx) },
	"cancel_followup": { group: "proactive", handler: (args, ctx) => handleScheduleFollowupGroup("cancel_followup", args, ctx) },
	"reschedule_followup": { group: "proactive", handler: (args, ctx) => handleScheduleFollowupGroup("reschedule_followup", args, ctx) },
	"suggest_routine": { group: "proactive", handler: (args, ctx) => handleScheduleFollowupGroup("suggest_routine", args, ctx) },
	"notify_user": { group: "proactive", handler: (args, ctx) => handleScheduleFollowupGroup("notify_user", args, ctx) },
};
