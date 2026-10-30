import type { ChatTool } from "@workspace/llm";
import { runSetup, type SetupArgs, type SetupDeps, type SetupResult } from "./machine.js";

export const PREVIEW_SETUP_TOOL_NAME = "preview_setup";

export const PREVIEW_SETUP_TOOL: ChatTool = {
	type: "function",
	function: {
		name: PREVIEW_SETUP_TOOL_NAME,
		description:
			"Set up the full live preview (private links to web projects) for this server: separate domain, wildcard DNS, HTTPS certificate, route, server variable, restart, final test. Server admin only. Steps: \"status\" (where we are; also after a restart), \"configure\" (save domain, DNS host, certificate kind, platform and the server public IPv4), \"run\" (do or verify the NEXT step; writes ask the user in a card first, the rest is explained step by step and verified), \"rollback\" (remove only the DNS record this setup created). USE when the admin asks for the full preview, the preview domain or to configure previews. Do NOT use to show a project (that is preview_start). Never ask for tokens in chat: use secret_request. Never mention tool names to the user; say \"endereço curinga\" and \"certificado de segurança (HTTPS)\".",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["status", "configure", "run", "rollback"] },
				domain: { type: "string", description: "configure: separate domain for previews, e.g. previas.example.com or myname.dedyn.io (not the Atlas domain)" },
				dns_provider: { type: "string", enum: ["cloudflare", "desec", "manual"], description: "configure: where the DNS of that domain is hosted" },
				tls: { type: "string", enum: ["dns01-proxy", "origin-cert"], description: "configure (optional): certificate kind; default fits the DNS host" },
				platform: { type: "string", enum: ["dokploy", "generic"], description: "configure (optional): where the Atlas runs; default generic" },
				server_ip: { type: "string", description: "configure: public IPv4 of the server" },
				user_confirms: { type: "boolean", description: "run: true ONLY after the user said they finished a manual step (variable, restart)" },
			},
			required: ["action"],
		},
	},
};

export type PreviewSetupToolContext = {
	/** O usuário do run é o administrador do servidor? Confere no executor, não no prompt. */
	isAdmin: () => Promise<boolean>;
	deps: SetupDeps;
};

const ACTIONS = ["status", "configure", "run", "rollback"] as const;

export async function executePreviewSetup(args: Record<string, unknown>, ctx: PreviewSetupToolContext): Promise<SetupResult> {
	if (!(await ctx.isAdmin())) throw new Error("This tool is not available. Tell the user in plain words that only the server administrator can set up the live preview, and offer screenshots of the project instead.");
	const action = args.action;
	if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) throw new Error(`action must be one of: ${ACTIONS.join(", ")}.`);
	return runSetup(ctx.deps, { ...(args as Omit<SetupArgs, "action">), action: action as SetupArgs["action"] });
}
