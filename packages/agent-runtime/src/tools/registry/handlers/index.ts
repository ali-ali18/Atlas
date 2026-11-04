import type { DefinedTool } from "../../define-tool.js";
import type { ToolFamily, ToolResolvers } from "../registry.js";
import { BROWSER_TOOLS, BROWSER_DEFINED } from "./browser.js";
import { FILES_TOOLS, FILES_DEFINED } from "./files.js";
import { MEMORY_TOOLS, MEMORY_DEFINED } from "./memory.js";
import { MISC_TOOLS, MISC_DEFINED } from "./misc.js";
import { VAULT_TOOLS, VAULT_DEFINED } from "./vault.js";
import { SKILLS_TOOLS, SKILLS_DEFINED } from "./skills.js";
import { EMAIL_TOOLS, EMAIL_DEFINED } from "./email.js";
import { PROACTIVE_TOOLS, PROACTIVE_DEFINED } from "./proactive.js";
import { CONNECTORS_TOOLS, CONNECTORS_DEFINED } from "./connectors.js";
import { ROUTINES_TOOLS, ROUTINES_DEFINED } from "./routines.js";
import { BOTS_TOOLS, BOTS_DEFINED } from "./bots.js";
import { PLANNING_TOOLS, PLANNING_DEFINED } from "./planning.js";
import { PAGES_TOOLS, PAGES_DEFINED } from "./pages.js";
import { LONG_WORK_TOOLS, LONG_WORK_DEFINED } from "./long-work.js";
import { connectorToolResolver } from "./connectors.js";
import { DEV_SESSION_DEFINED, devSessionResolver } from "./dev.js";
import { SANDBOX_TOOLS, SANDBOX_DEFINED } from "./sandbox.js";
import { WEB_TOOLS, WEB_DEFINED } from "./web.js";

/** Famílias de tools, na ordem de declaração (nome repetido entre famílias é erro). */
export const TOOL_FAMILIES: Array<() => ToolFamily> = [() => BROWSER_TOOLS, () => SANDBOX_TOOLS, () => WEB_TOOLS, () => FILES_TOOLS, () => MEMORY_TOOLS, () => MISC_TOOLS, () => VAULT_TOOLS, () => SKILLS_TOOLS, () => EMAIL_TOOLS, () => PROACTIVE_TOOLS, () => CONNECTORS_TOOLS, () => ROUTINES_TOOLS, () => BOTS_TOOLS, () => PLANNING_TOOLS, () => PAGES_TOOLS, () => LONG_WORK_TOOLS];

export const TOOL_RESOLVERS: ToolResolvers = { before: [() => devSessionResolver], after: [() => connectorToolResolver], defined: [() => DEV_SESSION_DEFINED] };

/**
 * Toda tool nativa declarada com `defineTool`/`defineRawTool`, por família (o catálogo `COMPUTER_USE_TOOLS` lê as
 * definições daqui). É uma função, não uma constante: há ciclo de import (família → registry → este arquivo), e
 * montar a lista no carregamento estouraria TDZ se uma família fosse o primeiro módulo importado.
 */
export function allDefinedTools(): readonly DefinedTool[] {
	return [...MISC_DEFINED, ...LONG_WORK_DEFINED, ...PLANNING_DEFINED, ...PROACTIVE_DEFINED, ...VAULT_DEFINED, ...MEMORY_DEFINED, ...WEB_DEFINED, ...SANDBOX_DEFINED, ...SKILLS_DEFINED, ...BOTS_DEFINED, ...CONNECTORS_DEFINED, ...FILES_DEFINED, ...PAGES_DEFINED, ...ROUTINES_DEFINED, ...EMAIL_DEFINED, ...BROWSER_DEFINED];
}
