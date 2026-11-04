import { appInfoTool } from "../../app-info.js";
import { currentTimeTool } from "../../current-time.js";
import { defineRawTool, definedFamily, type DefinedTool } from "../../define-tool.js";
import { toolCallTool, toolSearchTool } from "../../tool-bridge.js";
import type { ToolContext, ToolResult } from "../types.js";
import { PREVIEW_SETUP_TOOL, executePreviewSetup } from "../../preview-setup/tool.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";


import type { ToolFamily } from "../registry.js";

async function handlePreviewSetup(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	if (!ctx.previewSetup) throw new Error("This tool is not available in this run.");
	return (await executePreviewSetup(args, ctx.previewSetup)) as ToolResult;
}

/** Família `misc`: definição, metadado e handler de cada tool num lugar só (`defineTool`/`defineRawTool`, harness v3 PR5b). */
export const MISC_DEFINED: readonly DefinedTool[] = [
	appInfoTool,
	currentTimeTool,
	toolSearchTool,
	toolCallTool,
	defineRawTool({
		name: "preview_setup",
		definition: PREVIEW_SETUP_TOOL,
		effect: "write_internal",
		ownCard: true,
		group: "misc",
		run: handlePreviewSetup,
	}),
];

export const MISC_TOOLS: ToolFamily = definedFamily(MISC_DEFINED);
