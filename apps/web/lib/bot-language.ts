import { BOT_LANGUAGES, type BotLanguage } from "@workspace/shared";

export const DEFAULT_BOT_LANGUAGE: BotLanguage = "pt-BR";

export const BOT_LANGUAGE_LABELS: Record<BotLanguage, string> = {
	"pt-BR": "Português (Brasil)",
	"en-US": "English (US)",
	"es-ES": "Español (España)",
};

export const BOT_LANGUAGE_OPTIONS = BOT_LANGUAGES.map((id) => ({
	id,
	label: BOT_LANGUAGE_LABELS[id],
}));
