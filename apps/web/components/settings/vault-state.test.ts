import assert from "node:assert/strict";
import { test } from "node:test";
import type { VaultItemView } from "@/lib/atlas-api";
import { auditLabel, emptyVaultForm, filterVaultItems, formToInput, formatVaultDate, generatePassword, passwordStrength, validateVaultForm, withSuggestedName } from "./vault-state";

const item = (over: Partial<VaultItemView>): VaultItemView => ({ id: "1", kind: "secret", name: "openai", label: "", description: "chave da OpenAI", siteUrl: null, domain: null, username: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", lastUsedAt: null, alwaysBots: [], ...over });

test("gerador: tamanho, variedade e sem caracteres ambíguos", () => {
	for (let i = 0; i < 50; i += 1) {
		const pw = generatePassword({ length: 20 });
		assert.equal(pw.length, 20);
		assert.match(pw, /[a-z]/);
		assert.match(pw, /[A-Z]/);
		assert.match(pw, /\d/);
		assert.match(pw, /[^A-Za-z0-9]/);
		assert.doesNotMatch(pw, /[0OIl1]/);
	}
	assert.doesNotMatch(generatePassword({ symbols: false }), /[^A-Za-z0-9]/);
	assert.equal(generatePassword({ length: 3 }).length, 8);
	assert.notEqual(generatePassword(), generatePassword());
});

test("força da senha", () => {
	assert.equal(passwordStrength("").score, 0);
	assert.equal(passwordStrength("abc").label, "Fraca");
	assert.equal(passwordStrength(generatePassword({ length: 24 })).label, "Forte");
});

test("busca sem acento em nome, domínio, usuário e filtro por tipo", () => {
	const items = [item({}), item({ id: "2", kind: "login", name: "github", label: "GitHub", domain: "github.com", username: "ação@x.com", description: "" })];
	assert.deepEqual(filterVaultItems(items, "OPENAI").map((i) => i.id), ["1"]);
	assert.deepEqual(filterVaultItems(items, "acao git").map((i) => i.id), ["2"]);
	assert.deepEqual(filterVaultItems(items, "", "secret").map((i) => i.id), ["1"]);
	assert.deepEqual(filterVaultItems(items, "nada"), []);
});

test("nome do login acompanha o endereço até ser editado à mão", () => {
	let form = emptyVaultForm("login");
	form = withSuggestedName(form, { siteUrl: "https://www.github.com/login" });
	assert.equal(form.name, "github");
	assert.equal(form.label, "Github");
	form = withSuggestedName(form, { name: "meu-gh" });
	form = withSuggestedName(form, { siteUrl: "https://gitlab.com" });
	assert.equal(form.name, "meu-gh");
});

test("validação e corpo da API (edição não reenvia segredo vazio)", () => {
	const form = { ...emptyVaultForm("login"), name: "gh", siteUrl: "github.com", username: "ali", password: "" };
	assert.deepEqual(validateVaultForm(form, false), { ok: false, errors: { password: "Informe a senha (ou gere uma)." } });
	assert.equal(validateVaultForm(form, true).ok, true);
	assert.equal(validateVaultForm({ ...form, name: "nome inválido" }, true).ok, false);
	assert.equal(validateVaultForm({ ...form, siteUrl: "" }, true).ok, false);
	const body = formToInput({ ...form, password: "Abc12345!", totp: " GEZD " }, false);
	assert.deepEqual(body, { kind: "login", name: "gh", label: "", description: "", siteUrl: "https://github.com", username: "ali", password: "Abc12345!", totp: "GEZD" });
	assert.equal("password" in formToInput(form, true), false);
	assert.equal(validateVaultForm({ ...emptyVaultForm("secret"), name: "x" }, false).ok, false);
});

test("histórico legível e datas relativas", () => {
	assert.equal(auditLabel({ action: "revealed", actor: "user", botName: null, detail: null }), "Revelado por você");
	assert.equal(auditLabel({ action: "used", actor: "bot", botName: "Ana", detail: "login_fill: password" }), "Usado pelo bot Ana (login_fill: password)");
	const now = new Date("2026-10-15T12:00:00Z");
	assert.equal(formatVaultDate(null, now), "nunca");
	assert.equal(formatVaultDate("2026-10-15T11:30:00Z", now), "há 30 min");
	assert.equal(formatVaultDate("2026-10-13T12:00:00Z", now), "há 2 dias");
});
