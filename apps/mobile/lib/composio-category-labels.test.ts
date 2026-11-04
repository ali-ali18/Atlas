import { describe, expect, it } from "vitest";
import { categoryKey, composioCategoryLabel, composioCategoryRank, tidyCategoryName } from "./composio-category-labels";
import { deviceLanguage, languageCode } from "./device-language";

describe("composioCategoryLabel", () => {
	it("traduz os ids conhecidos para pt-BR", () => {
		expect(composioCategoryLabel("productivity", "productivity", "pt-BR")).toBe("Produtividade");
		expect(composioCategoryLabel("popular", "popular", "pt")).toBe("Populares");
		expect(composioCategoryLabel("developer-tools", "developer tools", "pt-BR")).toBe("Ferramentas de desenvolvimento");
		expect(composioCategoryLabel("social-media", "Social Media", "pt-BR")).toBe("Redes sociais");
	});
	it("acha pelo id mesmo com texto diferente, e pelo nome quando o id é opaco", () => {
		expect(composioCategoryLabel("x1", "Other / Miscellaneous", "pt-BR")).toBe("Outros");
		expect(composioCategoryLabel("Developer_Tools", "?", "pt-BR")).toBe("Ferramentas de desenvolvimento");
	});
	it("traduz para espanhol", () => {
		expect(composioCategoryLabel("communication", "communication", "es-MX")).toBe("Comunicación");
	});
	it("id desconhecido cai no original arrumado, nunca vazio", () => {
		expect(composioCategoryLabel("quantum-stuff", "quantum-stuff", "pt-BR")).toBe("Quantum stuff");
		expect(composioCategoryLabel("zzz", "", "pt-BR")).toBe("Zzz");
		expect(composioCategoryLabel("", "", "pt-BR")).not.toBe("");
	});
	it("idioma sem tabela devolve o original", () => {
		expect(composioCategoryLabel("productivity", "productivity", "fr")).toBe("productivity");
		expect(composioCategoryLabel("productivity", "Productivity", "en")).toBe("Productivity");
	});
	it("não quebra com ids como __proto__", () => {
		expect(composioCategoryLabel("__proto__", "__proto__", "pt")).toBe("Proto");
	});
	it("categoryKey e tidyCategoryName", () => {
		expect(categoryKey("Other / Miscellaneous")).toBe("other-miscellaneous");
		expect(tidyCategoryName("e-mail")).toBe("E mail");
	});
	it("ordem: popular primeiro, outros por último", () => {
		expect(composioCategoryRank("popular")).toBeLessThan(composioCategoryRank("ai"));
		expect(composioCategoryRank("ai")).toBeLessThan(composioCategoryRank("x", "Other / Miscellaneous"));
	});
});

describe("deviceLanguage", () => {
	it("usa o primeiro idioma do aparelho (injetável)", () => {
		expect(deviceLanguage([{ languageCode: "es", languageTag: "es-MX" }])).toBe("es");
		expect(deviceLanguage([{ languageCode: null, languageTag: "pt-BR" }])).toBe("pt");
	});
	it("sem idioma válido cai em pt", () => {
		expect(deviceLanguage([])).toBe("pt");
		expect(languageCode("")).toBeNull();
		expect(languageCode("EN_us")).toBe("en");
	});
});
