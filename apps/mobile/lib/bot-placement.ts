// Onde o bot mora na home: fixado (com a ordem na grade) e a seção. Mesmo `PATCH /v1/bots/:id` do web
// (`pinned`, `pinOrder`, `sectionId`); o servidor só altera bot do dono da sessão (404 para outro).
import { ChatApiError } from "./chat-api";
import type { ApiFetch } from "./home-sync";
import type { HomeBot } from "./home-types";

export type Placement = Pick<HomeBot, "pinned" | "pinOrder" | "sectionId">;

/** Fixar põe o bot no fim da grade; desafixar zera a ordem. */
export function pinPlacement(bot: Pick<HomeBot, "id">, bots: readonly Pick<HomeBot, "id" | "pinned" | "pinOrder">[], pinned: boolean): Pick<HomeBot, "pinned" | "pinOrder"> {
	if (!pinned) return { pinned: false, pinOrder: null };
	const last = bots.filter((other) => other.pinned && other.id !== bot.id).reduce((max, other) => Math.max(max, other.pinOrder ?? 0), 0);
	return { pinned: true, pinOrder: last + 1 };
}

/** Mudar de seção (ou sair dela com `null`). */
export function sectionPlacement(sectionId: string | null): Pick<HomeBot, "sectionId"> {
	return { sectionId };
}

export async function patchPlacement(apiFetch: ApiFetch, botId: string, patch: Partial<Placement>): Promise<void> {
	const response = await apiFetch(`/v1/bots/${encodeURIComponent(botId)}`, { method: "PATCH", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(patch) });
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
}
