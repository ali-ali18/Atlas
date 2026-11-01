import type { ToolFamily,ToolResolvers } from "../registry.js";

/** Famílias de tools, na ordem de declaração (nome repetido entre famílias é erro). */
export const TOOL_FAMILIES: Array<() => ToolFamily> = [];

export const TOOL_RESOLVERS: ToolResolvers = {};
