// Guarda: `microphonePermission: false` em qualquer plugin faz o prebuild do Android colocar RECORD_AUDIO na lista de
// bloqueio do manifesto (foi o que impedia o ditado de pedir permissão). O texto do microfone vem do expo-speech-recognition.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Plugin = string | [string, Record<string, unknown>?];

const config = JSON.parse(readFileSync(join(process.cwd(), "app.json"), "utf8")) as { expo: { plugins: Plugin[] } };

describe("app.json", () => {
	it("nenhum plugin desliga o microfone (RECORD_AUDIO seria bloqueada)", () => {
		const offenders = config.expo.plugins.filter((plugin): plugin is [string, Record<string, unknown>] => Array.isArray(plugin) && plugin[1]?.microphonePermission === false).map(([name]) => name);
		expect(offenders).toEqual([]);
	});
	it("expo-speech-recognition declara o texto do microfone", () => {
		const entry = config.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === "expo-speech-recognition");
		expect(typeof (Array.isArray(entry) ? entry[1]?.microphonePermission : null)).toBe("string");
	});
});
