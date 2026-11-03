import { appInfoTool } from "./app-info.js";
import { currentTimeTool } from "./current-time.js";
import type { DefinedTool } from "./define-tool.js";

/**
 * Tools declaradas com `defineTool` (definição + metadado + handler num lugar só). `getToolMeta` lê daqui antes da
 * tabela `TOOL_META`; tool nova entra aqui (o teste `define-tool.test.ts` impede que ela vá para a tabela).
 */
export const DEFINED_TOOLS: readonly DefinedTool[] = [appInfoTool, currentTimeTool];
