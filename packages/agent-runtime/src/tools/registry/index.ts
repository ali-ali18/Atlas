import { TOOL_FAMILIES, TOOL_RESOLVERS } from "./handlers/index.js";
import { declareToolFamilies } from "./registry.js";

declareToolFamilies(TOOL_FAMILIES, TOOL_RESOLVERS);

export { attachToolDefinitions, executeRegisteredTool, getToolRegistration, hasRegisteredTool, listRegisteredToolNames } from "./registry.js";
export type { ToolFamily, ToolResolver, ToolResolvers } from "./registry.js";
export type * from "./types.js";
