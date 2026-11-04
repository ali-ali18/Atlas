import type { ToolContext, ToolResult } from "../types.js";

import { executeSandboxShellTool } from "../../sandbox-shell.js";
import { SANDBOX_RELEASE_TOOL_NAME, executeSandboxRelease } from "../../sandbox-release.js";
import { VIDEO_TRANSCRIPT_TOOL_NAME, executeVideoTranscript } from "../../video-transcript.js";

import type { ToolFamily } from "../registry.js";
import { defineRawTool, definedFamily, type DefinedTool, toolNamed } from "../../define-tool.js";
import { SANDBOX_SHELL_TOOLS } from "../../sandbox-shell.js";
import { SANDBOX_RELEASE_TOOL } from "../../sandbox-release.js";
import { VIDEO_TRANSCRIPT_TOOL } from "../../video-transcript.js";

async function handleSandboxShellGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeSandboxShellTool(name, args, { manager: ctx.manager, getSessionId: ctx.getSessionId });
}

async function handleSandboxRelease(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeSandboxRelease({ manager: ctx.manager, conversationId: ctx.conversationId });
}

async function handleVideoTranscript(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeVideoTranscript(args, { manager: ctx.manager, getSessionId: ctx.getSessionId });
}

/** Família `sandbox`: definição, metadado e handler de cada tool num lugar só (`defineRawTool`, harness v3 PR5b). */
export const SANDBOX_DEFINED: readonly DefinedTool[] = [
	defineRawTool({
		name: "sandbox_shell",
		definition: toolNamed(SANDBOX_SHELL_TOOLS, "sandbox_shell"),
		effect: "write_internal",
		group: "sandbox",
		run: (args, ctx) => handleSandboxShellGroup("sandbox_shell", args, ctx),
	}),
	defineRawTool({
		name: "sandbox_shell_wait",
		definition: toolNamed(SANDBOX_SHELL_TOOLS, "sandbox_shell_wait"),
		effect: "read",
		poll: true,
		group: "sandbox",
		run: (args, ctx) => handleSandboxShellGroup("sandbox_shell_wait", args, ctx),
	}),
	defineRawTool({
		name: "sandbox_read",
		definition: toolNamed(SANDBOX_SHELL_TOOLS, "sandbox_read"),
		effect: "read",
		group: "sandbox",
		run: (args, ctx) => handleSandboxShellGroup("sandbox_read", args, ctx),
	}),
	defineRawTool({
		name: "sandbox_list",
		definition: toolNamed(SANDBOX_SHELL_TOOLS, "sandbox_list"),
		effect: "read",
		group: "sandbox",
		run: (args, ctx) => handleSandboxShellGroup("sandbox_list", args, ctx),
	}),
	defineRawTool({
		name: "sandbox_download",
		definition: toolNamed(SANDBOX_SHELL_TOOLS, "sandbox_download"),
		effect: "credential",
		effectForArgs: (args) => (args.use_browser_session === false ? "write_internal" : "credential"),
		catalogEffect: "write_internal",
		group: "sandbox",
		run: (args, ctx) => handleSandboxShellGroup("sandbox_download", args, ctx),
	}),
	defineRawTool({
		name: "sandbox_release",
		definition: SANDBOX_RELEASE_TOOL,
		effect: "write_internal",
		needsHuman: true,
		group: "sandbox",
		run: handleSandboxRelease,
	}),
	defineRawTool({
		name: "video_transcript",
		definition: VIDEO_TRANSCRIPT_TOOL,
		effect: "read",
		group: "sandbox",
		run: handleVideoTranscript,
	}),
];

export const SANDBOX_TOOLS: ToolFamily = definedFamily(SANDBOX_DEFINED);
