import assert from "node:assert/strict";
import test from "node:test";
import { BOT_LANGUAGE_SETTING_OPTIONS, botLanguageLabel } from "./bot-language";

test("seletor de idioma do bot começa em Automático e mantém os fixos", () => {
	assert.deepEqual(
		BOT_LANGUAGE_SETTING_OPTIONS.map((option) => option.id),
		["auto", "pt-BR", "en-US", "es-ES"],
	);
	assert.equal(botLanguageLabel("auto"), "Automático");
	assert.equal(botLanguageLabel("en-US"), "English (US)");
});
