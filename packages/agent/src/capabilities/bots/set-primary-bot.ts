// `set_primary_bot`: marca um bot como o "Bot principal" do dono (o que coordena e delega aos outros). A confirmação é do
// kernel (`confirm: "always"`): o dono vê o cartão e nada muda antes de aprovar; sem dono a capacidade nem entra.
import { resolveTargetBot, type BotRosterEntry } from "@workspace/shared";
import { z } from "zod";
import type { Bots } from "../../ports/bots.js";
import { defineTool } from "../../tools/define-tool.js";

function pick(wanted: string, roster: readonly BotRosterEntry[], selfId: string): { ok: true; bot: BotRosterEntry } | { ok: false; error: string } {
	const self = roster.find((bot) => bot.id === selfId);
	if (!wanted) return self ? { ok: true, bot: self } : { ok: false, error: "This bot was not found." };
	if (self && (wanted === self.id || wanted.toLowerCase() === self.name.trim().toLowerCase())) return { ok: true, bot: self };
	return resolveTargetBot(wanted, roster, selfId);
}

export function createSetPrimaryBotTool(bots: Pick<Bots, "roster" | "selfId" | "setPrimary">) {
	return defineTool({
		name: "set_primary_bot",
		description:
			"Mark a bot as the owner's \"main bot\" (the one that coordinates and delegates to the other bots). Use it ONLY after the owner agreed to set one, and only when none is set yet. The owner confirms in a card before anything changes. Omit bot to choose yourself. " +
			"Do not use it to change an existing main bot (the owner does that in the bot settings) or on your own initiative.",
		inputSchema: z.object({ bot: z.string().trim().min(1).max(120).optional().describe("Bot id or name; default is this bot.") }),
		effect: "write_internal",
		confirm: "always",
		riskFacts: () => ({ target: "Definir o bot principal" }),
		async enrichRiskFacts({ bot }, base, { ownerId }) {
			const roster = await bots.roster(ownerId);
			const picked = pick(bot ?? "", roster, bots.selfId);
			return picked.ok ? { ...base, target: `Definir ${picked.bot.name} como bot principal` } : base;
		},
		async execute({ bot }, ctx) {
			const roster = await bots.roster(ctx.ownerId);
			if (roster.length < 2) return { ok: false, error: "The owner has only one bot: there is nobody to coordinate.", hint: "Nothing was changed." };
			if (roster.some((entry) => entry.isPrimary)) return { ok: false, error: "There is already a main bot.", hint: "Tell the owner they can change it in the bot settings." };
			const picked = pick(bot ?? "", roster, bots.selfId);
			if (!picked.ok) return { ok: false, error: picked.error, hint: "Use list_bots to see the names." };
			if (!(await bots.setPrimary(ctx.ownerId, picked.bot.id))) return { ok: false, error: "Bot not found.", hint: "Nothing was changed." };
			return { ok: true, summary: `${picked.bot.name} is now the main bot.`, receipt: { what: `${picked.bot.name} definido como bot principal`, where: "Bots" } };
		},
	});
}
