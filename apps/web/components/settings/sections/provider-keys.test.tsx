import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiKeyProviderStatus } from "@workspace/shared";
import { Command, CommandList } from "@workspace/ui/components/command";
import { ProviderPickerOptions } from "@/components/model-picker/provider-picker-options";
import { normalizePickerModels, pickerProviderOf } from "@/lib/provider-model-picker";
import { SETTINGS_ITEMS, hiddenSettingsItems } from "../settings-registry";
import { ProviderKeyRow, keyProviderCaption } from "./provider-keys";

Object.assign(globalThis, { React });
const noop = () => {};
const status = (provider: ApiKeyProviderStatus["provider"], value: ApiKeyProviderStatus["status"], extra: Partial<ApiKeyProviderStatus> = {}): ApiKeyProviderStatus => ({
	provider, status: value, modelCount: value === "connected" ? 12 : null, updatedAt: null, lastLimitAt: null, lastError: null, ...extra,
});
const row = (provider: "anthropic" | "opencode-go", st?: ApiKeyProviderStatus, extra: Partial<React.ComponentProps<typeof ProviderKeyRow>> = {}) =>
	renderToStaticMarkup(<ProviderKeyRow busy={false} onRemove={noop} onSave={noop} onTest={noop} provider={provider} status={st} {...extra} />);

test("desconectado: rótulo à esquerda, campo de chave mascarado e botão Conectar", () => {
	const html = row("anthropic");
	assert.match(html, /Anthropic \(API\)/);
	assert.match(html, /Não conectado/);
	assert.match(html, /type="password"/);
	assert.match(html, /Conectar/);
	assert.doesNotMatch(html, /Remover/);
});

test("conectado: mostra quantidade de modelos, Testar e Remover, sem campo de chave", () => {
	const html = row("opencode-go", status("opencode-go", "connected"));
	assert.match(html, /OpenCode Go/);
	assert.match(html, /Conectado · 12 modelos/);
	assert.match(html, /Assinatura do OpenCode Go: modelos com limite de uso por janela/);
	assert.match(html, /Testar conexão/);
	assert.match(html, /Remover/);
	assert.doesNotMatch(html, /type="password"/);
	assert.doesNotMatch(html, /Atlas/);
});

test("erro e cofre ausente aparecem como alerta; chave nunca é ecoada", () => {
	const html = row("anthropic", status("anthropic", "error", { lastError: "auth_failed" }), { error: "Chave recusada pelo provedor. Confira e tente de novo.", vaultReady: false });
	assert.match(html, /Chave recusada/);
	assert.match(html, /CONNECTOR_ENCRYPTION_KEY/);
	assert.match(html, /role="alert"/);
	assert.equal(keyProviderCaption(status("anthropic", "connected", { modelCount: 1 })), "Conectado · 1 modelo");
});

test("itens de chaves ficam em Provedores e valem para qualquer usuário", () => {
	for (const id of ["provedores.anthropic", "provedores.opencode-go"]) {
		assert.ok(SETTINGS_ITEMS.some((item) => item.id === id && item.section === "provedores"));
		assert.equal(hiddenSettingsItems({ isOwner: false }).has(id), false);
	}
});

const mixed = normalizePickerModels([
	{ id: "openai/gpt-4o-mini", name: "Mini", provider: "openai", contextLength: 128000 },
	{ id: "anthropic-direct/claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", vendor: "anthropic", contextLength: null, capabilities: "unknown" },
	{ id: "opencode-go/kimi-k3", name: "Kimi K3", provider: "opencode-go", vendor: "opencode-go", contextLength: null, capabilities: "unknown" },
]);
const picker = (models: typeof mixed, query = "") =>
	renderToStaticMarkup(<Command shouldFilter={false}><CommandList><ProviderPickerOptions available={false} catalogAvailable={false} models={models} onConnect={noop} onSelect={noop} query={query} status={null} value="openai/gpt-4o-mini" /></CommandList></Command>);

test("seletor de modelo agrupa Anthropic e OpenCode Go quando conectados", () => {
	assert.equal(pickerProviderOf("anthropic-direct/x"), "anthropic");
	assert.equal(pickerProviderOf("anthropic/claude"), "openrouter");
	const html = picker(mixed);
	assert.match(html, /Mostrar modelos de Anthropic/);
	assert.match(html, /Mostrar modelos de OpenCode Go/);
	assert.match(html, /Mostrar modelos de OpenRouter/);
	assert.match(picker(mixed, "kimi"), /Kimi K3/);
});

test("sem conexão (sem modelos) os grupos não aparecem", () => {
	const html = picker(mixed.slice(0, 1));
	assert.doesNotMatch(html, /Mostrar modelos de Anthropic/);
	assert.doesNotMatch(html, /Mostrar modelos de OpenCode Go/);
});
