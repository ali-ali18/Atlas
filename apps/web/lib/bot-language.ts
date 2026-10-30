import { BOT_LANGUAGE_AUTO, BOT_LANGUAGES, type BotLanguage, type BotLanguageSetting } from "@workspace/shared";

export const DEFAULT_BOT_LANGUAGE: BotLanguage = "pt-BR";

export const BOT_LANGUAGE_LABELS: Record<BotLanguage, string> = {
	"pt-BR": "Português (Brasil)",
	"en-US": "English (US)",
	"es-ES": "Español (España)",
};

export const BOT_LANGUAGE_AUTO_LABEL = "Automático";

export const BOT_LANGUAGE_OPTIONS = BOT_LANGUAGES.map((id) => ({
	id,
	label: BOT_LANGUAGE_LABELS[id],
}));

/** Idiomas fixos + "Automático" (o bot responde no idioma da conversa), este primeiro. */
export const BOT_LANGUAGE_SETTING_OPTIONS: { id: BotLanguageSetting; label: string }[] = [
	{ id: BOT_LANGUAGE_AUTO, label: BOT_LANGUAGE_AUTO_LABEL },
	...BOT_LANGUAGE_OPTIONS,
];

/** Mesmas opções com o rótulo de "Automático" traduzido (nomes dos idiomas seguem autônimos). */
export function botLanguageSettingOptions(autoLabel: string = BOT_LANGUAGE_AUTO_LABEL): { id: BotLanguageSetting; label: string }[] {
	return [{ id: BOT_LANGUAGE_AUTO, label: autoLabel }, ...BOT_LANGUAGE_OPTIONS];
}

/** Nome de exibição de um idioma ou de "auto". */
export function botLanguageLabel(setting: BotLanguageSetting): string {
	return setting === BOT_LANGUAGE_AUTO ? BOT_LANGUAGE_AUTO_LABEL : BOT_LANGUAGE_LABELS[setting];
}
