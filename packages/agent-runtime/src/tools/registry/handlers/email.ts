import type { ToolContext, ToolResult } from "../types.js";
import { executeEmailTool } from "../../../email/tools.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";


import type { ToolFamily } from "../registry.js";

async function handleEmailListGroup(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeEmailTool(name, args, { email: ctx.email ?? undefined, userId: ctx.userId, botId: ctx.botId, conversationId: ctx.conversationId, runId: ctx.runId, origin: ctx.origin });
}

/** Família `email`. */
export const EMAIL_TOOLS: ToolFamily = {
	"email_list": { group: "email", handler: (args, ctx) => handleEmailListGroup("email_list", args, ctx) },
	"email_read": { group: "email", handler: (args, ctx) => handleEmailListGroup("email_read", args, ctx) },
	"email_reply": { group: "email", handler: (args, ctx) => handleEmailListGroup("email_reply", args, ctx) },
	"email_send": { group: "email", handler: (args, ctx) => handleEmailListGroup("email_send", args, ctx) },
	"email_create_mailbox": { group: "email", handler: (args, ctx) => handleEmailListGroup("email_create_mailbox", args, ctx) },
};
