import assert from "node:assert/strict";
import test from "node:test";
import type { AccountSettingsResponse } from "@workspace/shared";
import { resolveNewBotLanguage } from "./new-bot-language";

const response = (value: string) =>
	({ effective: { general: { defaultBotLanguage: { value, source: "user" } } } }) as unknown as AccountSettingsResponse;

test("bot novo usa o idioma padrão efetivo da conta", async () => {
	assert.equal(await resolveNewBotLanguage(async () => response("en-US")), "en-US");
});

test("falha ao ler as configurações não bloqueia: deixa o servidor decidir", async () => {
	assert.equal(
		await resolveNewBotLanguage(async () => {
			throw new Error("offline");
		}),
		undefined,
	);
});
