// `secret_list`: o que o cofre do dono tem, só NOMES e metadados (tipo, site, usuário). Nunca valor.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";

const MAX_LISTED = 200;

export function createSecretListTool() {
	return defineTool({
		name: "secret_list",
		description:
			"List the owner's vault: item names, what they are for, and for site logins the site and username. You never see values. " +
			"Use it before login_fill, or to check whether a key you need already exists before asking with secret_request. " +
			"To use a plain secret, write {{secret:<name>}} inside the arguments of a connector or code_shell call; the value is filled in at the last moment and hidden from results. Never ask the owner to paste a secret in the chat.",
		inputSchema: z.object({}),
		effect: "read",
		async execute(_args, ctx) {
			const handles = await ctx.ports.vault.listHandles(ctx.ownerId);
			if (handles.length === 0) return { ok: true, summary: "The vault is empty. Ask for what is missing with secret_request (never ask the owner to paste the value in the chat)." };
			const shown = handles.slice(0, MAX_LISTED);
			const lines = shown.map((h) => {
				if (h.kind === "login") return `- login "${h.id}" (${h.label}): site ${h.site ?? "not saved"}, username ${h.username ?? "not saved"}. Sign in with login_fill.`;
				return `- secret "${h.id}"${h.description ? `: ${h.description}` : h.label !== h.id ? `: ${h.label}` : ""}. Use as {{secret:${h.id}}}.`;
			});
			const more = handles.length > shown.length ? `\n(${handles.length - shown.length} more not shown.)` : "";
			return { ok: true, summary: `Owner's vault (you do not see the values):\n${lines.join("\n")}${more}` };
		},
	});
}
