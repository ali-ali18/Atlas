import type { ToolFamily, ToolResolvers } from "../registry.js";
import { BROWSER_TOOLS } from "./browser.js";
import { devSessionResolver } from "./dev.js";
import { SANDBOX_TOOLS } from "./sandbox.js";
import { WEB_TOOLS } from "./web.js";

/** Famílias de tools, na ordem de declaração (nome repetido entre famílias é erro). */
export const TOOL_FAMILIES: Array<() => ToolFamily> = [() => BROWSER_TOOLS, () => SANDBOX_TOOLS, () => WEB_TOOLS];

export const TOOL_RESOLVERS: ToolResolvers = { before: [() => devSessionResolver] };
