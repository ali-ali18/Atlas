import { executeDelegateV2 } from "../../../engine-v2/helpers.js";
import { executeNotebookRead, executeNotebookWrite } from "../../../engine-v2/notebook.js";
import type { ToolContext, ToolResult } from "../types.js";
import type { ToolFamily } from "../registry.js";
import { defineRawTool, definedFamily, type DefinedTool } from "../../define-tool.js";
import { NOTEBOOK_WRITE_TOOL, NOTEBOOK_READ_TOOL } from "../../../engine-v2/notebook.js";
import { DELEGATE_V2_TOOL } from "../../../engine-v2/helpers.js";

/**
 * Trabalho longo do motor v2 (F3): caderno da tarefa e ajudantes. As tools só existem no catálogo do v2 em
 * `long_work` (e `notebook_write` nos ajudantes); aqui só ficam registradas para o mesmo `executeTool` do v1.
 */
async function handleNotebookWrite(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeNotebookWrite(args, ctx);
}

async function handleNotebookRead(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeNotebookRead(args, ctx);
}

async function handleDelegate(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeDelegateV2(args, ctx.helpers);
}

/** Família `long-work`. `notebook_*` só mexem na memória do run (não são escrita em conta de usuário). */
/** Família `long-work`: definição, metadado e handler de cada tool num lugar só (`defineRawTool`, harness v3 PR5b). */
export const LONG_WORK_DEFINED: readonly DefinedTool[] = [
	defineRawTool({
		name: "notebook_write",
		definition: NOTEBOOK_WRITE_TOOL,
		effect: "write_internal",
		group: "planning",
		readOnly: true,
		run: handleNotebookWrite,
	}),
	defineRawTool({
		name: "notebook_read",
		definition: NOTEBOOK_READ_TOOL,
		effect: "read",
		group: "planning",
		readOnly: true,
		run: handleNotebookRead,
	}),
	defineRawTool({
		name: "delegate",
		definition: DELEGATE_V2_TOOL,
		effect: "write_internal",
		needsHuman: true,
		group: "planning",
		readOnly: false,
		run: handleDelegate,
	}),
];

export const LONG_WORK_TOOLS: ToolFamily = definedFamily(LONG_WORK_DEFINED);
