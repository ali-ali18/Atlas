import { persistConversationCardFromEvent } from "@workspace/db";
import type { ToolContext, ToolResult } from "../types.js";
export { executeAgentMemoryTool, type AgentMemoryDeps } from "../../registry/handlers/memory.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";

import { executeResearchNote } from "../../research-note.js";
import { executeTrackItems } from "../../track-items.js";
import { executeUpdateTaskList } from "../../task-list.js";
import { executeProposePlan } from "../../propose-plan.js";

import type { ToolFamily } from "../registry.js";
import { defineRawTool, definedFamily, type DefinedTool } from "../../define-tool.js";
import { RESEARCH_NOTE_TOOL } from "../../research-note.js";
import { PROPOSE_PLAN_TOOL } from "../../propose-plan.js";
import { UPDATE_TASK_LIST_TOOL } from "../../task-list.js";
import { TRACK_ITEMS_TOOL } from "../../track-items.js";

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
	await ctx.emitTaskList?.(outcome.items, outcome.deliverable ? { deliverable: outcome.deliverable } : undefined);
	return { summary: outcome.summary };
}

async function handleTrackItems(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeTrackItems(args, ctx);
}

/** Família `planning`: definição, metadado e handler de cada tool num lugar só (`defineRawTool`, harness v3 PR5b). */
export const PLANNING_DEFINED: readonly DefinedTool[] = [
	defineRawTool({
		name: "research_note",
		definition: RESEARCH_NOTE_TOOL,
		effect: "write_internal",
		group: "planning",
		run: handleResearchNote,
	}),
	defineRawTool({
		name: "propose_plan",
		definition: PROPOSE_PLAN_TOOL,
		effect: "write_internal",
		endsTurn: true,
		ownCard: true,
		group: "planning",
		run: handleProposePlan,
	}),
	defineRawTool({
		name: "update_task_list",
		definition: UPDATE_TASK_LIST_TOOL,
		effect: "write_internal",
		group: "planning",
		run: handleUpdateTaskList,
	}),
	defineRawTool({
		name: "track_items",
		definition: TRACK_ITEMS_TOOL,
		effect: "write_internal",
		group: "planning",
		run: handleTrackItems,
	}),
];

export const PLANNING_TOOLS: ToolFamily = definedFamily(PLANNING_DEFINED);
