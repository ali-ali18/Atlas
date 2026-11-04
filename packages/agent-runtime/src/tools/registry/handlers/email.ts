import type { ToolContext, ToolResult } from "../types.js";
import { executeEmailTool } from "../../../email/tools.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";


import type { ToolFamily } from "../registry.js";
import { defineRawTool, definedFamily, type DefinedTool } from "../../define-tool.js";
import { EMAIL_LIST_TOOL, EMAIL_READ_TOOL, EMAIL_REPLY_TOOL, EMAIL_SEND_TOOL, EMAIL_CREATE_MAILBOX_TOOL } from "../../../email/tools.js";

async function handleEmailListGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeEmailTool(name, args, { email: ctx.email ?? undefined, userId: ctx.userId, botId: ctx.botId, conversationId: ctx.conversationId, runId: ctx.runId, origin: ctx.origin });
}

/** Família `email`: definição, metadado e handler de cada tool num lugar só (`defineRawTool`, harness v3 PR5b). */
export const EMAIL_DEFINED: readonly DefinedTool[] = [
	defineRawTool({
		name: "email_list",
		definition: EMAIL_LIST_TOOL,
		effect: "read",
		group: "email",
		run: (args, ctx) => handleEmailListGroup("email_list", args, ctx),
	}),
	defineRawTool({
		name: "email_read",
		definition: EMAIL_READ_TOOL,
		effect: "read",
		group: "email",
		run: (args, ctx) => handleEmailListGroup("email_read", args, ctx),
	}),
	defineRawTool({
		name: "email_reply",
		definition: EMAIL_REPLY_TOOL,
		effect: "send",
		ownCard: true,
		group: "email",
		run: (args, ctx) => handleEmailListGroup("email_reply", args, ctx),
	}),
	defineRawTool({
		name: "email_send",
		definition: EMAIL_SEND_TOOL,
		effect: "send",
		ownCard: true,
		group: "email",
		run: (args, ctx) => handleEmailListGroup("email_send", args, ctx),
	}),
	defineRawTool({
		name: "email_create_mailbox",
		definition: EMAIL_CREATE_MAILBOX_TOOL,
		effect: "write_external",
		ownCard: true,
		group: "email",
		run: (args, ctx) => handleEmailListGroup("email_create_mailbox", args, ctx),
	}),
];

export const EMAIL_TOOLS: ToolFamily = definedFamily(EMAIL_DEFINED);
