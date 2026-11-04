import type { ToolFamily } from "../registry.js";
import { definedFamily, type DefinedTool } from "../../define-tool.js";
import { PREPARE_FOR_OWNER_DEFINED } from "../../prepare-for-owner.js";
import { ROUTINE_LIMITS_DEFINED } from "../../routine-limits.js";

/**
 * Família `owner-control` (motor v3, PR8b): rascunho aprovável para o dono (`prepare_for_owner`) e limites da rotina
 * pelo chat (`routine_limits`). Registrada para o executor achar o handler, mas fora de `COMPUTER_USE_TOOLS`: v1 e v2
 * não a oferecem; o v3 a acrescenta ao catálogo dele (`engine-v3/prepare.ts`).
 */
export const OWNER_CONTROL_DEFINED: readonly DefinedTool[] = [PREPARE_FOR_OWNER_DEFINED, ROUTINE_LIMITS_DEFINED];

export const OWNER_CONTROL_TOOLS: ToolFamily = definedFamily(OWNER_CONTROL_DEFINED);
