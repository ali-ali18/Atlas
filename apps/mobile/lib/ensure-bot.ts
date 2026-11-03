// Põe na home um bot que o servidor acabou de criar (pelo cartão "Criar agente") ou que o app ainda não tem (cartão já
// aprovado em outro aparelho). Busca o bot de verdade (com o `conversationId` dele): inserir um sem conversa faria a
// primeira mensagem criar uma conversa paralela. Só se a busca falhar entra o bot provisório, e a atualização em
// segundo plano é NOVA (não reaproveita uma que já estava em voo e não conhece o bot).
import type { HomeBot } from "./home-types";

export type EnsureBotDeps = {
	fetchBot: (botId: string) => Promise<HomeBot | null>;
	addBot: (bot: HomeBot) => void;
	/** Atualização da home; `fresh` descarta a que está em voo e busca de novo. */
	refresh: (options: { fresh: boolean }) => Promise<void>;
};

/** `true` se o bot de verdade (com conversa) entrou na home. */
export async function ensureHomeBot(deps: EnsureBotDeps, botId: string, fallback?: HomeBot): Promise<boolean> {
	const real = await deps.fetchBot(botId).catch(() => null);
	const bot = real ?? fallback;
	if (bot) deps.addBot(bot);
	void deps.refresh({ fresh: true }).catch(() => undefined);
	return real !== null;
}
