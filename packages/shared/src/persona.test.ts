import { describe, expect, it } from "vitest";
import { languageInstruction } from "./bot-language.js";
import { buildPersonaBlock, PERSONA_ROLE_MAX_CHARS } from "./persona.js";

describe("persona do bot (bloco único de identidade, estilo e idioma)", () => {
	it("traz nome, papel, estilo e o idioma do bot, em inglês e uma vez só", () => {
		const block = buildPersonaBlock({ name: "TomTom", role: "Cuida das vendas da loja.", language: "pt-BR" });
		expect(block.startsWith("Persona:\n")).toBe(true);
		expect(block).toContain('- You are "TomTom", a personal assistant');
		expect(block).toContain("- Your role, from your profile: Cuida das vendas da loja.");
		expect(block).toContain('Speak as "TomTom" in the first person');
		expect(block).toContain("Agree because something is right, not because the user said it.");
		expect(block).toContain(languageInstruction("pt-BR"));
		expect(block.split(languageInstruction("pt-BR"))).toHaveLength(2);
		expect(block).not.toMatch(/SEMPRE|NUNCA|IDENTIDADE|Responda/);
	});

	it("bot em inglês nunca recebe português; em espanhol recebe espanhol", () => {
		const en = buildPersonaBlock({ name: "Ada", language: "en-US" });
		expect(en).toContain("Always reply to the user in American English.");
		expect(en).not.toMatch(/portugu/i);
		expect(buildPersonaBlock({ name: "Ada", language: "es-ES" })).toContain("European Spanish");
		expect(buildPersonaBlock({ name: "Ada", language: "pt-BR" })).toContain("Brazilian Portuguese");
	});

	it("sem nome vira assistente genérico; papel longo é cortado; espaços normalizados", () => {
		const generic = buildPersonaBlock({ language: "pt-BR" });
		expect(generic).toContain("- You are a personal assistant");
		expect(generic).not.toContain("Speak as");
		expect(generic).not.toContain("Your role");
		const long = buildPersonaBlock({ name: "  Bia \n", role: "x".repeat(PERSONA_ROLE_MAX_CHARS + 50), language: "pt-BR" });
		expect(long).toContain('"Bia"');
		expect(long).toContain(`from your profile: ${"x".repeat(PERSONA_ROLE_MAX_CHARS)}\n`);
	});
});
