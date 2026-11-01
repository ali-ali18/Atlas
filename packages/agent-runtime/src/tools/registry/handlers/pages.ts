import type { ToolContext, ToolResult } from "../types.js";
export { executeAgentMemoryTool, type AgentMemoryDeps } from "../../registry/handlers/memory.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";

import { executePageTool } from "../../pages.js";

import type { ToolFamily } from "../registry.js";

async function handlePageCreateGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executePageTool(name, args, {
		userId: ctx.userId,
		botId: ctx.botId,
		conversationId: ctx.conversationId,
		runId: ctx.runId,
		store: ctx.pagesStore,
		shareStore: ctx.pageShareStore,
		routinePageId: ctx.routinePageId,
		researchNotes: ctx.researchNotes ? () => ctx.researchNotes!.snapshot() : undefined,
		emitPage: ctx.emitPage,
	});
}

/** Família `pages`. */
export const PAGES_TOOLS: ToolFamily = {
	"page_create": { group: "pages", handler: (args, ctx) => handlePageCreateGroup("page_create", args, ctx) },
	"page_update": { group: "pages", handler: (args, ctx) => handlePageCreateGroup("page_update", args, ctx) },
	"page_read": { group: "pages", handler: (args, ctx) => handlePageCreateGroup("page_read", args, ctx) },
	"page_list": { group: "pages", handler: (args, ctx) => handlePageCreateGroup("page_list", args, ctx) },
	"page_share": { group: "pages", handler: (args, ctx) => handlePageCreateGroup("page_share", args, ctx) },
};
