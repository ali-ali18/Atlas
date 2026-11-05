import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, THEME_OPTIONS, parsePreferences, resolveColorScheme, serializePreferences, themePreferenceLabel } from "./preferences";

describe("resolveColorScheme", () => {
	it("escolha explícita vence o sistema", () => {
		expect(resolveColorScheme("dark", "light")).toBe("dark");
		expect(resolveColorScheme("light", "dark")).toBe("light");
	});
	it("Sistema segue o aparelho e, sem ele, o claro", () => {
		expect(resolveColorScheme("system", "dark")).toBe("dark");
		expect(resolveColorScheme("system", "light")).toBe("light");
		expect(resolveColorScheme("system", null)).toBe("light");
		expect(resolveColorScheme("system", undefined)).toBe("light");
	});
});

describe("parsePreferences", () => {
	it("sem nada guardado ou com lixo: padrão", () => {
		expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
		expect(parsePreferences("")).toEqual(DEFAULT_PREFERENCES);
		expect(parsePreferences("{quebrado")).toEqual(DEFAULT_PREFERENCES);
		expect(parsePreferences("[1,2]")).toEqual(DEFAULT_PREFERENCES);
		expect(parsePreferences("7")).toEqual(DEFAULT_PREFERENCES);
	});
	it("campo inválido volta ao padrão sem perder os outros", () => {
		expect(parsePreferences(JSON.stringify({ theme: "roxo", haptics: false, autoTimezone: "sim" }))).toEqual({ theme: "system", haptics: false, autoTimezone: null });
	});
	it("ida e volta", () => {
		const preferences = { theme: "dark", haptics: false, autoTimezone: false } as const;
		expect(parsePreferences(serializePreferences(preferences))).toEqual(preferences);
	});
});

describe("rótulos", () => {
	it("tema em pt-BR, na ordem Sistema, Claro, Escuro", () => {
		expect(THEME_OPTIONS.map((option) => option.label)).toEqual(["Sistema", "Claro", "Escuro"]);
		expect(themePreferenceLabel("dark")).toBe("Escuro");
	});
});
