import { LANGUAGE_SPECS } from "./language-registry.js";

/** Idiomas concretos suportados (derivados do registro: idioma novo = uma entrada em `language-registry.ts`). */
export type BotLanguage = keyof typeof LANGUAGE_SPECS;

export const BOT_LANGUAGES = Object.keys(LANGUAGE_SPECS) as BotLanguage[];

/** Idioma padrão quando nada diz outra coisa (bot, conta e navegador sem pista). */
export const DEFAULT_BOT_LANGUAGE: BotLanguage = "pt-BR";

/** Valor de `Bot.language` que segue o idioma de quem escreve em vez de fixar um. */
export const BOT_LANGUAGE_AUTO = "auto";

/** Configuração do bot: um idioma fixo ou "auto". Valor desconhecido (versão antiga) vale como o padrão. */
export type BotLanguageSetting = BotLanguage | typeof BOT_LANGUAGE_AUTO;

export const BOT_LANGUAGE_SETTINGS: readonly BotLanguageSetting[] = [...BOT_LANGUAGES, BOT_LANGUAGE_AUTO];

export function isBotLanguage(value: unknown): value is BotLanguage {
	return BOT_LANGUAGES.some((language) => language === value);
}

export function isBotLanguageSetting(value: unknown): value is BotLanguageSetting {
	return value === BOT_LANGUAGE_AUTO || isBotLanguage(value);
}

/** Lê o que veio do banco/cliente: aceita "auto" e idiomas fixos; o resto cai no padrão. */
export function parseBotLanguageSetting(value: unknown): BotLanguageSetting {
	return isBotLanguageSetting(value) ? value : DEFAULT_BOT_LANGUAGE;
}

/**
 * Locale livre ("en", "en-GB", "pt_PT", "es-MX") → idioma suportado pelo subtag principal. `null` se não há
 * correspondência (ex.: "fr-FR").
 */
export function matchBotLanguage(tag: unknown): BotLanguage | null {
	if (typeof tag !== "string") return null;
	const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
	if (!primary) return null;
	return BOT_LANGUAGES.find((language) => language.toLowerCase().split("-")[0] === primary) ?? null;
}

/** Primeiro idioma suportado de um `Accept-Language` ("fr;q=0.9, en-GB;q=0.8" → en-US), por ordem de qualidade. */
export function pickLanguageFromAcceptLanguage(header: unknown): BotLanguage | null {
	if (typeof header !== "string") return null;
	const ranked = header
		.slice(0, 512)
		.split(",")
		.map((part, index) => {
			const [tag = "", ...params] = part.trim().split(";");
			const q = Number(params.map((param) => param.trim()).find((param) => param.startsWith("q="))?.slice(2) ?? "1");
			return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
		})
		.filter((entry) => entry.tag && entry.tag !== "*" && entry.q > 0)
		.sort((a, b) => b.q - a.q || a.index - b.index);
	for (const entry of ranked) {
		const match = matchBotLanguage(entry.tag);
		if (match) return match;
	}
	return null;
}

/** Instructions for model-generated content that a user may read. */
export function languageInstruction(language: BotLanguage): string {
	const name = LANGUAGE_SPECS[language].name;
	return `Always reply to the user in ${name}. Anything the user will read — card titles, routine names and prompts, questionnaire text, reminders — must also be in ${name}. This language instruction overrides any earlier instruction about the response language.`;
}

/**
 * Modo "auto" com mensagem do usuário na vez: o modelo lê o idioma da última mensagem; `fallback` vale só para
 * mensagem curta ou ambígua. Texto curto, no fim do prompt (o prefixo em cache não muda com o idioma).
 */
export function autoLanguageInstruction(fallback: BotLanguage): string {
	const name = LANGUAGE_SPECS[fallback].name;
	return `Reply in the language of the user's latest message. If it is too short or ambiguous (ok, emoji, names, code), reply in ${name}. Anything the user will read — card titles, routine names and prompts, questionnaire text, reminders — must follow that same language. This overrides any earlier instruction about the response language.`;
}

/** Todas as instruções de idioma possíveis: a retomada de um run troca a antiga pela atual por texto exato. */
export function allLanguageInstructions(): string[] {
	return BOT_LANGUAGES.flatMap((language) => [languageInstruction(language), autoLanguageInstruction(language)]);
}

export type ReplyLanguageInput = {
	/** `Bot.language` (fixo ou "auto"). */
	setting: BotLanguageSetting;
	/** Último idioma detectado nesta conversa/conta (valor livre do banco; inválido é ignorado). */
	lastLanguage?: string | null;
	/** Locale da conta/navegador, usado quando não há idioma detectado. */
	accountLocale?: string | null;
	/** Há mensagem de usuário na vez (chat)? Rotina, alerta, "Seu dia", proativo e workers: não. */
	hasUserMessage: boolean;
};

export type ReplyLanguage = {
	/** Idioma concreto resolvido (o que vale para texto do sistema e para a instrução fixa). */
	language: BotLanguage;
	/** `true` quando o próprio modelo decide pelo idioma da mensagem (auto com mensagem). */
	followsUser: boolean;
	instruction: string;
};

/**
 * Idioma da resposta. Fixo: o do bot, sem mudança. "auto": com mensagem do usuário o modelo segue o idioma dela
 * (e o resolvido é só o plano B para mensagem ambígua); sem mensagem, vale o último idioma detectado, depois o
 * locale da conta e por fim pt-BR, com a instrução fixa de sempre.
 */
export function resolveReplyLanguage(input: ReplyLanguageInput): ReplyLanguage {
	if (input.setting !== BOT_LANGUAGE_AUTO) {
		const language = isBotLanguage(input.setting) ? input.setting : DEFAULT_BOT_LANGUAGE;
		return { language, followsUser: false, instruction: languageInstruction(language) };
	}
	const language = matchBotLanguage(input.lastLanguage) ?? matchBotLanguage(input.accountLocale) ?? DEFAULT_BOT_LANGUAGE;
	if (input.hasUserMessage) return { language, followsUser: true, instruction: autoLanguageInstruction(language) };
	return { language, followsUser: false, instruction: languageInstruction(language) };
}
