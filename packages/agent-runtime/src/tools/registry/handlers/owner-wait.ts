import type { ToolFamily } from "../registry.js";
import { definedFamily, type DefinedTool } from "../../define-tool.js";
import { CANCEL_RETURN_DEFINED, SCHEDULE_RETURN_DEFINED } from "../../schedule-return.js";

/**
 * Família `owner-wait` (motor v3, PR8a): "Volto depois". Registrada para o executor achar o handler, mas fora de
 * `COMPUTER_USE_TOOLS`: v1 e v2 não a oferecem; o v3 a acrescenta ao catálogo dele (`engine-v3/prepare.ts`).
 */
export const OWNER_WAIT_DEFINED: readonly DefinedTool[] = [SCHEDULE_RETURN_DEFINED, CANCEL_RETURN_DEFINED];

export const OWNER_WAIT_TOOLS: ToolFamily = definedFamily(OWNER_WAIT_DEFINED);
