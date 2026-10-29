import { describe, expect, it } from "vitest";
import {
	allLanguageInstructions,
	autoLanguageInstruction,
	BOT_LANGUAGES,
	BOT_LANGUAGE_SETTINGS,
	isBotLanguage,
	isBotLanguageSetting,
	languageInstruction,
	matchBotLanguage,
	parseBotLanguageSetting,
	pickLanguageFromAcceptLanguage,
	resolveReplyLanguage,
} from "./bot-language.js";
import { LANGUAGE_SPECS } from "./language-registry.js";

describe("bot language", () => {
	it.each([
		["pt-BR", "Brazilian Portuguese"],
		["en-US", "American English"],
		["es-ES", "European Spanish"],
	] as const)("instructs user-facing output in %s", (language, name) => {
		const instruction = languageInstruction(language);
		expect(instruction).toContain(`Always reply to the user in ${name}.`);
		expect(instruction).toContain(`card titles, routine names and prompts, questionnaire text, reminders — must also be in ${name}.`);
		expect(instruction).toContain("overrides any earlier instruction about the response language");
	});

	it("accepts only supported languages", () => {
		expect(isBotLanguage("pt-BR")).toBe(true);
		expect(isBotLanguage("en-US")).toBe(true);
		expect(isBotLanguage("es-ES")).toBe(true);
		expect(isBotLanguage("fr-FR")).toBe(false);
		expect(isBotLanguage(null)).toBe(false);
	});

	it("auto is a setting but not a concrete language", () => {
		expect(isBotLanguage("auto")).toBe(false);
		expect(isBotLanguageSetting("auto")).toBe(true);
		expect(isBotLanguageSetting("fr-FR")).toBe(false);
		expect(BOT_LANGUAGE_SETTINGS).toEqual([...BOT_LANGUAGES, "auto"]);
		expect(parseBotLanguageSetting("auto")).toBe("auto");
		expect(parseBotLanguageSetting("en-US")).toBe("en-US");
		// valor desconhecido (de uma versão futura ou lixo) cai no padrão, como o código antigo fazia
		expect(parseBotLanguageSetting("xx")).toBe("pt-BR");
		expect(parseBotLanguageSetting(null)).toBe("pt-BR");
	});

	it("derives the supported languages from the registry (one entry per language)", () => {
		expect([...BOT_LANGUAGES]).toEqual(Object.keys(LANGUAGE_SPECS));
	});

	it("maps free locales to a supported language", () => {
		expect(matchBotLanguage("en")).toBe("en-US");
		expect(matchBotLanguage("en-GB")).toBe("en-US");
		expect(matchBotLanguage("pt_PT")).toBe("pt-BR");
		expect(matchBotLanguage("ES-mx")).toBe("es-ES");
		expect(matchBotLanguage("fr-FR")).toBeNull();
		expect(matchBotLanguage("")).toBeNull();
		expect(matchBotLanguage(undefined)).toBeNull();
		expect(pickLanguageFromAcceptLanguage("fr-FR,fr;q=0.9,en-GB;q=0.8,pt;q=0.7")).toBe("en-US");
		expect(pickLanguageFromAcceptLanguage("de, *;q=0.5")).toBeNull();
		expect(pickLanguageFromAcceptLanguage("es;q=0.4, pt-BR;q=0.9")).toBe("pt-BR");
		expect(pickLanguageFromAcceptLanguage(undefined)).toBeNull();
	});
});

describe("resolveReplyLanguage", () => {
	it("a fixed language keeps today's behavior, with or without a user message", () => {
		for (const hasUserMessage of [true, false]) {
			const resolved = resolveReplyLanguage({ setting: "es-ES", lastLanguage: "en-US", accountLocale: "pt-BR", hasUserMessage });
			expect(resolved).toEqual({ language: "es-ES", followsUser: false, instruction: languageInstruction("es-ES") });
		}
	});

	it("auto with a user message tells the model to follow it, keeping the last language for ambiguous text", () => {
		const resolved = resolveReplyLanguage({ setting: "auto", lastLanguage: "en-US", accountLocale: "pt-BR", hasUserMessage: true });
		expect(resolved.followsUser).toBe(true);
		expect(resolved.language).toBe("en-US");
		expect(resolved.instruction).toBe(autoLanguageInstruction("en-US"));
		expect(resolved.instruction).toContain("latest message");
		expect(resolved.instruction).toContain("too short or ambiguous (ok, emoji, names, code), reply in American English");
		expect(resolved.instruction).not.toMatch(/portugu/i);
	});

	it("auto without a user message uses the stored language, then the account locale, then pt-BR", () => {
		const base = { setting: "auto", hasUserMessage: false } as const;
		expect(resolveReplyLanguage({ ...base, lastLanguage: "en-US", accountLocale: "es-ES" })).toMatchObject({ language: "en-US", instruction: languageInstruction("en-US"), followsUser: false });
		expect(resolveReplyLanguage({ ...base, lastLanguage: null, accountLocale: "es-MX" }).language).toBe("es-ES");
		expect(resolveReplyLanguage({ ...base, lastLanguage: "fr-FR", accountLocale: "de" }).language).toBe("pt-BR");
		expect(resolveReplyLanguage({ ...base }).language).toBe("pt-BR");
	});

	it("an unknown stored setting behaves as pt-BR", () => {
		expect(resolveReplyLanguage({ setting: "xx" as never, hasUserMessage: true })).toMatchObject({ language: "pt-BR", followsUser: false });
	});

	it("auto instruction stays short (it goes at the end of every auto prompt)", () => {
		expect(autoLanguageInstruction("pt-BR").length).toBeLessThan(400);
	});

	it("lists every possible instruction so a resumed run can swap the old one", () => {
		const all = allLanguageInstructions();
		expect(all).toHaveLength(BOT_LANGUAGES.length * 2);
		expect(new Set(all).size).toBe(all.length);
		for (const language of BOT_LANGUAGES) {
			expect(all).toContain(languageInstruction(language));
			expect(all).toContain(autoLanguageInstruction(language));
		}
	});
});
