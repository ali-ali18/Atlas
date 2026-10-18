export const BOT_LANGUAGES = ["pt-BR", "en-US", "es-ES"] as const;

export type BotLanguage = (typeof BOT_LANGUAGES)[number];

export function isBotLanguage(value: unknown): value is BotLanguage {
	return BOT_LANGUAGES.some((language) => language === value);
}

const LANGUAGE_NAMES: Record<BotLanguage, string> = {
	"pt-BR": "Brazilian Portuguese",
	"en-US": "American English",
	"es-ES": "European Spanish",
};

/** Instructions for model-generated content that a user may read. */
export function languageInstruction(language: BotLanguage): string {
	const name = LANGUAGE_NAMES[language];
	return `Always reply to the user in ${name}. Anything the user will read — card titles, routine names and prompts, questionnaire text, reminders — must also be in ${name}. This language instruction overrides any earlier instruction about the response language.`;
}
