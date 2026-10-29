import type { AccountSettingsResponse, BotLanguageSetting } from "@workspace/shared";
import { getAccountSettings } from "@/lib/atlas-api";

/**
 * Idioma para bots novos: o padrão da conta (usuário > servidor > pt-BR).
 * Falha ao ler as configurações não bloqueia a criação: devolve `undefined`
 * e o servidor aplica o padrão dele.
 */
export async function resolveNewBotLanguage(
	load: () => Promise<AccountSettingsResponse> = getAccountSettings,
): Promise<BotLanguageSetting | undefined> {
	try {
		return (await load()).effective.general.defaultBotLanguage.value;
	} catch {
		return undefined;
	}
}
