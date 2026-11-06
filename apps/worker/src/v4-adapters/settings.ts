// Porta `Settings` do v4 no worker (F2.6): configurar o bot do run pelo chat. O bot vem preso na montagem e só é lido ou
// mudado se for do dono (`getAgentV4BotSettings` e `updateBot` filtram por `ownerId`).
//
// `roleModels` (modelo por papel) AINDA NÃO TEM ONDE SER GUARDADO: não existe coluna nem chave de política para isso e esta
// etapa não cria migration. Ler devolve `{}` (todo papel no padrão) e pedir uma troca falha com mensagem clara, em vez de
// aceitar e não guardar (tool honesta, `60-agente.md`). Quando houver o campo, só este arquivo muda.
import type { BotSettingsPatch, BotSettingsView, Settings } from "@workspace/agent";
import { getAgentV4BotSettings, updateBot } from "@workspace/db";
import { isBotLanguageSetting, type UpdateBotInput } from "@workspace/shared";

export type V4SettingsDeps = {
	getBot: typeof getAgentV4BotSettings;
	update: (botId: string, patch: UpdateBotInput, ownerId: string) => Promise<unknown>;
};

export const realV4SettingsDeps: V4SettingsDeps = { getBot: getAgentV4BotSettings, update: (botId, patch, ownerId) => updateBot(botId, patch, ownerId) };

export const ROLE_MODELS_UNAVAILABLE = "Choosing a model per role is not available yet. Tell the owner plainly; the bot keeps using its current models.";

export function createV4Settings(input: { botId: string; deps?: V4SettingsDeps }): Settings {
	const deps = input.deps ?? realV4SettingsDeps;
	const view = async (userId: string): Promise<BotSettingsView> => {
		const bot = await deps.getBot(userId, input.botId);
		if (!bot) throw new Error("Bot not found for this owner.");
		return { name: bot.name, snippet: bot.snippet, description: bot.description ?? "", language: isBotLanguageSetting(bot.language) ? bot.language : "pt-BR", notify: bot.notify, roleModels: {} };
	};
	return {
		// Sem onde guardar: a capacidade não registra `set_role_model` e `settings_get` não lista papéis.
		supportsRoleModels: false,
		get: view,
		async update(userId, patch: BotSettingsPatch) {
			if (patch.roleModels && Object.keys(patch.roleModels).length > 0) throw new Error(ROLE_MODELS_UNAVAILABLE);
			// Confere o dono antes de escrever (bot de outro dono dá o mesmo erro de inexistente).
			await view(userId);
			if (patch.language !== undefined && !isBotLanguageSetting(patch.language)) throw new Error(`Unknown language "${patch.language}".`);
			const update: UpdateBotInput = {
				...(patch.language !== undefined && isBotLanguageSetting(patch.language) && { language: patch.language }),
				...(patch.notify !== undefined && { notify: patch.notify }),
				...(patch.profile?.name !== undefined && { name: patch.profile.name }),
				...(patch.profile?.snippet !== undefined && { snippet: patch.profile.snippet }),
				...(patch.profile?.description !== undefined && { description: patch.profile.description }),
			};
			if (Object.keys(update).length > 0) await deps.update(input.botId, update, userId);
			return view(userId);
		},
	};
}
