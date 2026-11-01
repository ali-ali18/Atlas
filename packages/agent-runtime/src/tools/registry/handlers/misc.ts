import { executeAppInfo } from "../../app-info.js";
import { executeCurrentTime } from "../../current-time.js";
import type { ToolContext, ToolResult } from "../types.js";
import { executePreviewSetup } from "../../preview-setup/tool.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";


import type { ToolFamily } from "../registry.js";

async function handleAppInfo(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeAppInfo(args);
}

async function handleCurrentTime(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeCurrentTime(args, { now: new Date(), timeZone: ctx.timeZone });
}

async function handlePreviewSetup(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	if (!ctx.previewSetup) throw new Error("This tool is not available in this run.");
	return (await executePreviewSetup(args, ctx.previewSetup)) as ToolResult;
}

/** Família `misc`. */
export const MISC_TOOLS: ToolFamily = {
	"app_info": { group: "misc", handler: handleAppInfo },
	"current_time": { group: "misc", handler: handleCurrentTime },
	"preview_setup": { group: "misc", handler: handlePreviewSetup },
};
