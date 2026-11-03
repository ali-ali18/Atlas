import { appInfoTool } from "../../app-info.js";
import { currentTimeTool } from "../../current-time.js";
import { definedFamily } from "../../define-tool.js";
import type { ToolContext, ToolResult } from "../types.js";
import { executePreviewSetup } from "../../preview-setup/tool.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";


import type { ToolFamily } from "../registry.js";

async function handlePreviewSetup(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	if (!ctx.previewSetup) throw new Error("This tool is not available in this run.");
	return (await executePreviewSetup(args, ctx.previewSetup)) as ToolResult;
}

/** Família `misc`. */
export const MISC_TOOLS: ToolFamily = {
	...definedFamily([appInfoTool, currentTimeTool]),
	"preview_setup": { group: "misc", handler: handlePreviewSetup },
};
