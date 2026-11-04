// "Criar" do formulário de novo bot, sem React: valida, cria no servidor, insere o bot na home e pede a atualização em
// segundo plano. Um toque só vale por vez (o segundo, com a criação em voo, é ignorado) e a falha volta a liberar o botão.
import { createErrorText } from "./bot-api";
import { isUnauthorized } from "./chat-api";
import type { HomeBot } from "./home-types";
import { buildNewBotBody, type NewBotBody, type NewBotInput } from "./new-bot";

export type NewBotDeps = {
	createBot: (body: NewBotBody) => Promise<HomeBot>;
	/** Põe o bot na lista da home (e no cache do aparelho), protegido contra uma atualização em voo. */
	addBot: (bot: HomeBot) => void;
	/** Atualização da home em segundo plano (traz a conversa e a prévia do bot novo). */
	refresh: () => Promise<void>;
	onUnauthorized: () => void;
};

export type NewBotOutcome = { ok: true; botId: string } | { ok: false; error: string };

export function createNewBotSubmitter(deps: NewBotDeps): (input: NewBotInput) => Promise<NewBotOutcome | null> {
	let inFlight = false;
	// Depois de criado, o formulário só espera a navegação: um toque a mais não pode criar outro bot.
	let created = false;
	return async (input) => {
		if (inFlight || created) return null;
		const check = buildNewBotBody(input);
		if (!check.ok) return { ok: false, error: check.error };
		inFlight = true;
		try {
			const bot = await deps.createBot(check.body);
			created = true;
			deps.addBot(bot);
			void deps.refresh().catch(() => undefined);
			return { ok: true, botId: bot.id };
		} catch (reason) {
			if (isUnauthorized(reason)) deps.onUnauthorized();
			return { ok: false, error: createErrorText(reason) };
		} finally {
			inFlight = false;
		}
	};
}
