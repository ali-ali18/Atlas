// `list_bots`: os bots do dono (nome, papel, principal). Leitura; serve para escolher o destino de `send_to_bot`.
import { z } from "zod";
import type { Bots } from "../../ports/bots.js";
import { defineTool } from "../../tools/define-tool.js";

const MAX_LISTED = 20;

export function createListBotsTool(bots: Pick<Bots, "roster" | "selfId">) {
	return defineTool({
		name: "list_bots",
		description:
			"List the owner's bots: name, id, short role and which one is the main bot. Use it to pick the target of send_to_bot or to answer which bots the owner has. Do not use it to list routines, panels or connectors.",
		inputSchema: z.object({}),
		effect: "read",
		async execute(_args, ctx) {
			const roster = await bots.roster(ctx.ownerId);
			if (roster.length === 0) return { ok: true, summary: "The owner has no bots." };
			const lines = roster.slice(0, MAX_LISTED).map((bot) => {
				const role = (bot.snippet || bot.description || "").replace(/\s+/g, " ").trim().slice(0, 160);
				return `- ${bot.name} (id ${bot.id})${bot.id === bots.selfId ? " [this bot]" : ""}${bot.isPrimary ? " [main bot]" : ""}${role ? `: ${role}` : ""}`;
			});
			const more = roster.length > MAX_LISTED ? `\n(${roster.length - MAX_LISTED} more not shown.)` : "";
			return { ok: true, summary: `The owner's bots:\n${lines.join("\n")}${more}` };
		},
	});
}
