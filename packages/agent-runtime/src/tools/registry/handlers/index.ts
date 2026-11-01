import type { ToolFamily, ToolResolvers } from "../registry.js";
import { BROWSER_TOOLS } from "./browser.js";
import { FILES_TOOLS } from "./files.js";
import { MEMORY_TOOLS } from "./memory.js";
import { MISC_TOOLS } from "./misc.js";
import { VAULT_TOOLS } from "./vault.js";
import { SKILLS_TOOLS } from "./skills.js";
import { EMAIL_TOOLS } from "./email.js";
import { PROACTIVE_TOOLS } from "./proactive.js";
import { CONNECTORS_TOOLS } from "./connectors.js";
import { ROUTINES_TOOLS } from "./routines.js";
import { BOTS_TOOLS } from "./bots.js";
import { PLANNING_TOOLS } from "./planning.js";
import { PAGES_TOOLS } from "./pages.js";
import { connectorToolResolver } from "./connectors.js";
import { devSessionResolver } from "./dev.js";
import { SANDBOX_TOOLS } from "./sandbox.js";
import { WEB_TOOLS } from "./web.js";

/** Famílias de tools, na ordem de declaração (nome repetido entre famílias é erro). */
export const TOOL_FAMILIES: Array<() => ToolFamily> = [() => BROWSER_TOOLS, () => SANDBOX_TOOLS, () => WEB_TOOLS, () => FILES_TOOLS, () => MEMORY_TOOLS, () => MISC_TOOLS, () => VAULT_TOOLS, () => SKILLS_TOOLS, () => EMAIL_TOOLS, () => PROACTIVE_TOOLS, () => CONNECTORS_TOOLS, () => ROUTINES_TOOLS, () => BOTS_TOOLS, () => PLANNING_TOOLS, () => PAGES_TOOLS];

export const TOOL_RESOLVERS: ToolResolvers = { before: [() => devSessionResolver], after: [() => connectorToolResolver] };
