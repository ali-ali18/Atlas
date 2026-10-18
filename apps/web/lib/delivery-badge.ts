import type { Bot } from "@workspace/shared";

/** Badge de "resultados novos": o bot tem resultado de run em background que o dono ainda não viu. */
export function hasUnreadResults(bot: Pick<Bot, "unreadResults">): boolean {
	return (bot.unreadResults ?? 0) > 0;
}
