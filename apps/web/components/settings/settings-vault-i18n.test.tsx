import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { VaultItemView } from "@/lib/atlas-api";
import { createTranslator } from "@/lib/i18n/translator";
import { loadMessages } from "@/lib/i18n/messages";
import { renderIn } from "./settings-i18n-render";
import { auditLabel, emptyVaultForm, formatVaultDate, passwordStrength, validateVaultForm } from "./vault-state";
import { VaultDetailView, VaultFormView, VaultListView } from "./sections/vault";

Object.assign(globalThis, { React });

const noop = () => {};
const login: VaultItemView = { id: "1", kind: "login", name: "github", label: "GitHub", description: "", siteUrl: "https://github.com", domain: "github.com", username: "alice@x.com", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", lastUsedAt: null, alwaysBots: [] };
const tr = async (locale: "en-US" | "es-ES") => createTranslator(locale, await loadMessages(locale));

test("Cofre em inglês: lista, vazio e busca sem resultado", async () => {
	const props = { available: true, filter: "all" as const, onAdd: noop, onFilter: noop, onOpen: noop, onQuery: noop };
	const html = await renderIn("en-US", <VaultListView {...props} items={[login]} query="" />);
	assert.match(html, /Passwords and keys are encrypted for you only/);
	assert.match(html, /aria-label="Search the vault"/);
	assert.match(html, /Site login/);
	assert.match(html, /Never used/);
	assert.match(html, />Secrets</);
	assert.match(await renderIn("en-US", <VaultListView {...props} items={[]} query="" />), /The vault is empty/);
	assert.match(await renderIn("en-US", <VaultListView {...props} items={[login]} query="zzz" />), /Nothing found for &quot;zzz&quot;/);
	assert.doesNotMatch(html, /Senhas|Nunca usado/);
});

test("Cofre em inglês: detalhe com histórico, contagem e botões", async () => {
	const audit = [{ id: "a", action: "used", actor: "bot", botId: "b", botName: "Ana", conversationId: "c", detail: null, createdAt: "2026-10-15T10:00:00Z" }];
	const html = await renderIn("en-US", <VaultDetailView audit={audit as never} copied={null} item={login} onCopy={noop} onDelete={noop} onEdit={noop} onHide={noop} onReveal={noop} revealed={null} totp={{ code: "287082", expiresInSec: 12 }} />);
	assert.match(html, /Changes in 12s/);
	assert.match(html, /Used by bot Ana/);
	assert.match(html, /aria-label="Copy password"/);
	assert.match(html, /Revelar|Reveal/);
	assert.match(html, />Delete</);
	assert.match(html, /Notes and extra fields appear when revealed\./);
});

test("Cofre em espanhol: formulário e erros", async () => {
	const form = { ...emptyVaultForm("login"), password: "Abc12345!xyz" };
	const html = await renderIn("es-ES", <VaultFormView editing={false} errors={{ password: "x" }} form={form} onCancel={noop} onChange={noop} onCheckTotp={noop} onGenerate={noop} onQr={noop} onSave={noop} qrSupported />);
	assert.match(html, /Enlace del sitio/);
	assert.match(html, /Añadir campo/);
	assert.match(html, /Leer QR de una imagen/);
	assert.match(html, /Nombre para el bot/);
	const es = await tr("es-ES");
	const checked = validateVaultForm(emptyVaultForm("login"), false, es);
	assert.equal(checked.ok, false);
	if (!checked.ok) assert.equal(checked.errors.password, "Indica la contraseña (o genera una).");
});

test("estado do cofre: datas, força e histórico por idioma", async () => {
	const en = await tr("en-US");
	const now = new Date("2026-10-15T12:00:00Z");
	assert.equal(formatVaultDate("2026-10-13T12:00:00Z", now, en), "2 days ago");
	assert.equal(formatVaultDate(null, now, en), "never");
	assert.equal(passwordStrength("Abc12345!xyz", en).label, "Fair");
	assert.equal(auditLabel({ action: "revealed", actor: "user", botName: null, detail: null }, en), "Revealed by you");
});
