import type { ToolContext, ToolResult } from "../types.js";
export { executeAgentMemoryTool, type AgentMemoryDeps } from "../../registry/handlers/memory.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";

import { executePageTool } from "../../pages.js";

import type { ToolFamily } from "../registry.js";
import { defineRawTool, definedFamily, type DefinedTool } from "../../define-tool.js";
import { PAGE_CREATE_TOOL, PAGE_UPDATE_TOOL, PAGE_READ_TOOL, PAGE_LIST_TOOL, PAGE_SHARE_TOOL } from "../../pages.js";

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

/** Família `pages`: definição, metadado e handler de cada tool num lugar só (`defineRawTool`, harness v3 PR5b). */
export const PAGES_DEFINED: readonly DefinedTool[] = [
	defineRawTool({
		name: "page_create",
		definition: PAGE_CREATE_TOOL,
		effect: "write_internal",
		group: "pages",
		run: (args, ctx) => handlePageCreateGroup("page_create", args, ctx),
	}),
	defineRawTool({
		name: "page_update",
		definition: PAGE_UPDATE_TOOL,
		effect: "write_internal",
		group: "pages",
		run: (args, ctx) => handlePageCreateGroup("page_update", args, ctx),
	}),
	defineRawTool({
		name: "page_read",
		definition: PAGE_READ_TOOL,
		effect: "read",
		group: "pages",
		run: (args, ctx) => handlePageCreateGroup("page_read", args, ctx),
	}),
	defineRawTool({
		name: "page_list",
		definition: PAGE_LIST_TOOL,
		effect: "read",
		group: "pages",
		run: (args, ctx) => handlePageCreateGroup("page_list", args, ctx),
	}),
	defineRawTool({
		name: "page_share",
		definition: PAGE_SHARE_TOOL,
		effect: "public_link",
		group: "pages",
		run: (args, ctx) => handlePageCreateGroup("page_share", args, ctx),
	}),
];

export const PAGES_TOOLS: ToolFamily = definedFamily(PAGES_DEFINED);
