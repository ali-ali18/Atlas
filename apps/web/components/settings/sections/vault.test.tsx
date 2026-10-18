import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VaultItemView } from "@/lib/atlas-api";
import { emptyVaultForm } from "../vault-state";
import { VaultDetailView, VaultFormView, VaultListView } from "./vault";

Object.assign(globalThis, { React });

const login: VaultItemView = { id: "1", kind: "login", name: "github", label: "GitHub", description: "", siteUrl: "https://github.com", domain: "github.com", username: "alice@x.com", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", lastUsedAt: null, alwaysBots: [] };
const secret: VaultItemView = { ...login, id: "2", kind: "secret", name: "openai", label: "", description: "Chave da OpenAI", siteUrl: null, domain: null, username: null };
const noop = () => {};

const list = (over = {}) => renderToStaticMarkup(<VaultListView available filter="all" items={[login, secret]} onAdd={noop} onFilter={noop} onOpen={noop} onQuery={noop} query="" {...over} />);

test("lista: cartão por item com nome, usuário e domínio; busca e filtros", () => {
	const html = list();
	assert.match(html, /GitHub/);
	assert.match(html, /alice@x\.com · github\.com/);
	assert.match(html, /Chave da OpenAI/);
	assert.match(html, /Login de site/);
	assert.match(html, /Buscar/);
	assert.match(html, /Logins/);
	assert.match(html, /\/v1\/mcp\/icon\/github\.com/);
	assert.match(list({ query: "xyz" }), /Nada encontrado/);
});

test("lista vazia e cofre indisponível", () => {
	assert.match(list({ items: [] }), /O cofre está vazio/);
	assert.match(list({ available: false }), /CONNECTOR_ENCRYPTION_KEY/);
});

test("detalhe: senha mascarada até revelar; código 2FA, histórico e marcador do bot", () => {
	const props = { item: login, audit: [{ id: "a", action: "used", actor: "bot", botId: "b", botName: "Ana", conversationId: "c", detail: "login_fill: password", createdAt: "2026-10-15T10:00:00Z" }], revealed: null, totp: { code: "287082", expiresInSec: 12 }, copied: null, onReveal: noop, onHide: noop, onCopy: noop, onEdit: noop, onDelete: noop, };
	const hidden = renderToStaticMarkup(<VaultDetailView {...props} />);
	assert.match(hidden, /••••••••••••/);
	assert.match(hidden, /287 082/);
	assert.match(hidden, /Muda em 12s/);
	assert.match(hidden, /data-slot="vault-countdown"/);
	assert.match(hidden, /data-slot="input-group"/);
	assert.doesNotMatch(hidden, /Fechar/);
	assert.match(hidden, /Usado pelo bot Ana/);
	assert.match(hidden, /\{\{login:github\.password\}\}/);
	const shown = renderToStaticMarkup(<VaultDetailView {...props} revealed={{ password: "Sup3rSenha!" }} />);
	assert.match(shown, /Sup3rSenha!/);
	assert.doesNotMatch(hidden, /Sup3rSenha!/);
});

test("formulário de login: gerador, 2FA, campos extras e nome para o bot", () => {
	const form = { ...emptyVaultForm("login"), siteUrl: "github.com", name: "github", password: "Abc12345!xyz" };
	const html = renderToStaticMarkup(<VaultFormView editing={false} errors={{ password: "Informe a senha (ou gere uma)." }} form={form} onCancel={noop} onChange={noop} onCheckTotp={noop} onGenerate={noop} onQr={noop} onSave={noop} qrSupported />);
	assert.match(html, /Link do site/);
	assert.match(html, /Gerar/);
	assert.match(html, /Código 2FA/);
	assert.match(html, /Adicionar campo/);
	assert.match(html, /Ler QR de uma imagem/);
	assert.match(html, /data-slot="vault-strength"/);
	assert.match(html, /\{\{login:github\.password\}\}/);
	assert.match(html, /Informe a senha/);
	const secretForm = renderToStaticMarkup(<VaultFormView editing={false} errors={{}} form={{ ...emptyVaultForm("secret"), name: "openai" }} onCancel={noop} onChange={noop} onCheckTotp={noop} onGenerate={noop} onQr={noop} onSave={noop} />);
	assert.match(secretForm, /\{\{secret:openai\}\}/);
	assert.doesNotMatch(secretForm, /Link do site/);
});
