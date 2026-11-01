import type { ToolContext, ToolResult } from "../types.js";

import { executeSandboxShellTool } from "../../sandbox-shell.js";
import { SANDBOX_RELEASE_TOOL_NAME, executeSandboxRelease } from "../../sandbox-release.js";

import type { ToolFamily } from "../registry.js";

async function handleSandboxShellGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeSandboxShellTool(name, args, { manager: ctx.manager, getSessionId: ctx.getSessionId });
}

async function handleSandboxRelease(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeSandboxRelease({ manager: ctx.manager, conversationId: ctx.conversationId });
}

/** Família `sandbox`. */
export const SANDBOX_TOOLS: ToolFamily = {
	"sandbox_shell": { group: "sandbox", handler: (args, ctx) => handleSandboxShellGroup("sandbox_shell", args, ctx) },
	"sandbox_shell_wait": { group: "sandbox", handler: (args, ctx) => handleSandboxShellGroup("sandbox_shell_wait", args, ctx) },
	"sandbox_read": { group: "sandbox", handler: (args, ctx) => handleSandboxShellGroup("sandbox_read", args, ctx) },
	"sandbox_list": { group: "sandbox", handler: (args, ctx) => handleSandboxShellGroup("sandbox_list", args, ctx) },
	"sandbox_download": { group: "sandbox", handler: (args, ctx) => handleSandboxShellGroup("sandbox_download", args, ctx) },
	[SANDBOX_RELEASE_TOOL_NAME]: { group: "sandbox", handler: handleSandboxRelease },
};
