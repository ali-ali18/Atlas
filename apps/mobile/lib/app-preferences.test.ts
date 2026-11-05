import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getItemAsync, setColorScheme } = vi.hoisted(() => ({ getItemAsync: vi.fn<(key: string) => Promise<string | null>>(), setColorScheme: vi.fn() }));
vi.mock("expo-secure-store", () => ({ getItemAsync: (key: string) => getItemAsync(key), setItemAsync: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, Appearance: { setColorScheme }, useColorScheme: () => "light" }));

import { DEFAULT_PREFERENCES } from "./preferences";
import { loadPreferences } from "./preferences-store";

describe("preferências guardadas no aparelho", () => {
	beforeEach(() => {
		getItemAsync.mockReset();
	});

	it.each(["{not json", "[]", "null", '"dark"', '{"theme":"neon","haptics":"sim","autoTimezone":3}', ""])("valor corrompido %j vira o padrão sem lançar", async (raw) => {
		getItemAsync.mockResolvedValue(raw);
		await expect(loadPreferences()).resolves.toEqual(DEFAULT_PREFERENCES);
	});

	it("cofre que lança vira o padrão", async () => {
		getItemAsync.mockImplementation(async () => {
			throw new Error("keystore indisponível");
		});
		await expect(loadPreferences()).resolves.toEqual(DEFAULT_PREFERENCES);
	});

	it("lê o que foi guardado", async () => {
		getItemAsync.mockResolvedValue('{"theme":"dark","haptics":false,"autoTimezone":true}');
		await expect(loadPreferences()).resolves.toEqual({ theme: "dark", accent: "bot", haptics: false, autoTimezone: true });
	});
});

describe("app-preferences e o Android", () => {
	it("nunca chama Appearance.setColorScheme (recria a Activity e o app fechava ao abrir)", async () => {
		const code = readFileSync(resolve(__dirname, "app-preferences.tsx"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		expect(code).not.toMatch(/setColorScheme/);
		expect(code).not.toMatch(/\bAppearance\b/);
		await import("./app-preferences");
		expect(setColorScheme).not.toHaveBeenCalled();
	});

	it("o layout raiz exporta o layout e envolve tudo no provedor de preferências", () => {
		const layout = readFileSync(resolve(__dirname, "../app/_layout.tsx"), "utf8");
		expect(layout).not.toMatch(/setColorScheme/);
		expect(layout).toMatch(/export default function RootLayout/);
		expect(layout).toMatch(/<AppPreferencesProvider>/);
	});
});
