import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "@/lib/i18n/translator";
import { loadMessages } from "@/lib/i18n/messages";
import { SETTINGS_ITEMS, SETTINGS_NAV, navSectionLabel, searchSettings, settingsSearchTerms } from "./settings-registry";

async function search(locale: "pt-BR" | "en-US" | "es-ES", query: string) {
	const t = createTranslator(locale, await loadMessages(locale)).t;
	return searchSettings(query, undefined, (id) => navSectionLabel(t, id), settingsSearchTerms(t));
}

test("todo item e seção do registro tem termos de busca nos três idiomas", async () => {
	for (const locale of ["pt-BR", "en-US", "es-ES"] as const) {
		const terms = settingsSearchTerms(createTranslator(locale, await loadMessages(locale)).t);
		for (const entry of SETTINGS_NAV) assert.ok(terms("nav", entry.id).length > 1, `${locale} nav ${entry.id}`);
		for (const item of SETTINGS_ITEMS) assert.ok(terms("item", item.id).length > 1, `${locale} item ${item.id}`);
	}
});

test("pt-BR do dicionário é o mesmo texto do registro (nome e palavras-chave)", async () => {
	const terms = settingsSearchTerms(createTranslator("pt-BR", await loadMessages("pt-BR")).t);
	for (const entry of SETTINGS_NAV) assert.deepEqual(terms("nav", entry.id), [entry.label, ...entry.keywords].map((text) => text.trim()));
	for (const item of SETTINGS_ITEMS) assert.deepEqual(terms("item", item.id), [item.label, ...item.keywords].map((text) => text.trim()));
});

test("busca em inglês acha a configuração pelo termo em inglês", async () => {
	const result = await search("en-US", "password");
	assert.ok(result.entries.some((entry) => entry.id === "cofre"));
	const dark = await search("en-US", "dark");
	assert.deepEqual(dark.entries.map((entry) => entry.id), ["geral"]);
	assert.ok(dark.itemFilter.geral?.has("geral.tema"));
});

test("busca em espanhol acha por 'zona horaria' e 'contraseña'", async () => {
	assert.ok((await search("es-ES", "zona horaria")).itemFilter.geral?.has("geral.fuso"));
	assert.ok((await search("es-ES", "contrasena")).entries.some((entry) => entry.id === "cofre"));
});

test("busca em pt-BR continua funcionando em qualquer idioma da tela", async () => {
	const result = await search("en-US", "fuso");
	assert.ok(result.itemFilter.geral?.has("geral.fuso"));
});
