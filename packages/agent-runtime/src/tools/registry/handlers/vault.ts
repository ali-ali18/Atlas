import { isUnattendedOrigin } from "../../../autonomy-gate.js";
import type { ToolContext, ToolResult } from "../types.js";
import { executeLoginFill, executeRoutineWebhookInfo, executeSecretList, executeSecretRequest, type VaultToolContext } from "../../vault-tools.js";
export { executeDevSessionTool } from "../../registry/handlers/dev.js";


import type { ToolFamily } from "../registry.js";
import { defineRawTool, definedFamily, type DefinedTool } from "../../define-tool.js";
import { SECRET_LIST_TOOL, ROUTINE_WEBHOOK_INFO_TOOL, SECRET_REQUEST_TOOL, LOGIN_FILL_TOOL } from "../../vault-tools.js";

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

/** Família `vault`: definição, metadado e handler de cada tool num lugar só (`defineRawTool`, harness v3 PR5b). */
export const VAULT_DEFINED: readonly DefinedTool[] = [
	defineRawTool({
		name: "secret_list",
		definition: SECRET_LIST_TOOL,
		effect: "read",
		group: "vault",
		run: handleSecretList,
	}),
	defineRawTool({
		name: "routine_webhook_info",
		definition: ROUTINE_WEBHOOK_INFO_TOOL,
		effect: "read",
		group: "vault",
		run: handleRoutineWebhookInfo,
	}),
	defineRawTool({
		name: "secret_request",
		definition: SECRET_REQUEST_TOOL,
		effect: "credential",
		endsTurn: true,
		ownCard: true,
		group: "vault",
		run: handleSecretRequest,
	}),
	defineRawTool({
		name: "login_fill",
		definition: LOGIN_FILL_TOOL,
		effect: "credential",
		endsTurn: true,
		ownCard: true,
		group: "vault",
		run: handleLoginFill,
	}),
];

export const VAULT_TOOLS: ToolFamily = definedFamily(VAULT_DEFINED);

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
