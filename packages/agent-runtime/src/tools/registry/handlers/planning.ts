import { persistConversationCardFromEvent } from "@workspace/db";
import type { ToolContext, ToolResult } from "../types.js";
export { executeAgentMemoryTool, type AgentMemoryDeps } from "../../registry/handlers/memory.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";

import { executeResearchNote } from "../../research-note.js";
import { executeTrackItems } from "../../track-items.js";
import { executeUpdateTaskList } from "../../task-list.js";
import { executeProposePlan } from "../../propose-plan.js";

import type { ToolFamily } from "../registry.js";

async function handleResearchNote(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeResearchNote(args, ctx);
}

async function handleProposePlan(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const outcome = await executeProposePlan(args, {
		userId: ctx.userId,
		botId: ctx.botId,
		conversationId: ctx.conversationId,
		runId: ctx.runId,
		origin: ctx.origin,
		markPending: ctx.markPlanPending,
		persistCard: (conversationId, card) => persistConversationCardFromEvent(conversationId, card),
	});
	return { summary: outcome.summary, confirmEvent: outcome.confirmEvent };
}

async function handleUpdateTaskList(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const outcome = executeUpdateTaskList(args, ctx);
	await ctx.emitTaskList?.(outcome.items);
	return { summary: outcome.summary };
}

async function handleTrackItems(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeTrackItems(args, ctx);
}

/** Família `planning`. */
export const PLANNING_TOOLS: ToolFamily = {
	"research_note": { group: "planning", handler: handleResearchNote },
	"propose_plan": { group: "planning", handler: handleProposePlan },
	"update_task_list": { group: "planning", handler: handleUpdateTaskList },
	"track_items": { group: "planning", handler: handleTrackItems },
};
