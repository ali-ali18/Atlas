import { executeDelegateV2 } from "../../../engine-v2/helpers.js";
import { executeNotebookRead, executeNotebookWrite } from "../../../engine-v2/notebook.js";
import type { ToolContext, ToolResult } from "../types.js";
import type { ToolFamily } from "../registry.js";

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
export const LONG_WORK_TOOLS: ToolFamily = {
	"notebook_write": { group: "planning", readOnly: true, handler: handleNotebookWrite },
	"notebook_read": { group: "planning", readOnly: true, handler: handleNotebookRead },
	"delegate": { group: "planning", readOnly: false, handler: handleDelegate },
};
