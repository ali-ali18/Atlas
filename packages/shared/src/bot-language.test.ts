import { describe, expect, it } from "vitest";
import { isBotLanguage, languageInstruction } from "./bot-language.js";

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
});
