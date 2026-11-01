import { isUnattendedOrigin } from "../../../autonomy-gate.js";
import type { ToolContext, ToolResult } from "../types.js";
import { executeLoginFill, executeRoutineWebhookInfo, executeSecretList, executeSecretRequest, type VaultToolContext } from "../../vault-tools.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";


import type { ToolFamily } from "../registry.js";

async function handleSecretList(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeSecretList(vaultToolContext(ctx));
}

async function handleRoutineWebhookInfo(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return executeRoutineWebhookInfo(vaultToolContext(ctx));
}

async function handleSecretRequest(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return (await executeSecretRequest(args, vaultToolContext(ctx))) as ToolResult;
}

async function handleLoginFill(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	return (await executeLoginFill(args, vaultToolContext(ctx))) as ToolResult;
}

/** Família `vault`. */
export const VAULT_TOOLS: ToolFamily = {
	"secret_list": { group: "vault", handler: handleSecretList },
	"routine_webhook_info": { group: "vault", handler: handleRoutineWebhookInfo },
	"secret_request": { group: "vault", handler: handleSecretRequest },
	"login_fill": { group: "vault", handler: handleLoginFill },
};

export function vaultToolContext(ctx: Pick<ToolContext, "userId" | "botId" | "conversationId" | "runId" | "origin" | "manager" | "getSessionId">): VaultToolContext {
	return {
		userId: ctx.userId,
		botId: ctx.botId,
		conversationId: ctx.conversationId,
		runId: ctx.runId,
		origin: ctx.origin,
		unattended: isUnattendedOrigin(ctx.origin),
		browser: {
			currentUrl: async () => (await ctx.manager.execBrowserText(await ctx.getSessionId(), { mode: "viewport", limit: 1 })).url,
			readPage: async () => {
				const page = await ctx.manager.execBrowserText(await ctx.getSessionId(), { mode: "viewport", limit: 1 });
				return { url: page.url, title: page.title };
			},
			type: async (selector, text, submit, guard) => {
				const result = await ctx.manager.execBrowserType(await ctx.getSessionId(), { selector, text, submit, ...(guard ? { guard } : {}) });
				if (result.ok === false) throw new Error("campo não encontrado");
			},
		},
	};
}
