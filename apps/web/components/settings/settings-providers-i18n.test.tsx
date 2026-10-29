import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { EffectiveAccountConfig, EmailDomainDto } from "@workspace/shared";
import { createTranslator } from "@/lib/i18n/translator";
import { loadMessages } from "@/lib/i18n/messages";
import { renderIn } from "./settings-i18n-render";
import { chatgptSwitchHint, providerConnectionLabel } from "./providers-state";
import { dictationDefaultLabel, maintenanceInheritLabel, modelSettingWarning } from "./models-state";
import { EmailDomainsPanel } from "./sections/email-domains";
import { EmailKeyRow } from "./sections/email-key";
import { ModelTiersSettingsView } from "./sections/model-tiers";
import { ModelsSettingsView } from "./sections/models";
import { NotificationsSettingsView } from "./sections/notifications";
import { ProviderKeyRow } from "./sections/provider-keys";
import { ProvidersSettingsView } from "./sections/providers";

Object.assign(globalThis, { React });

const noop = () => {};
const tr = async (locale: "en-US" | "es-ES") => createTranslator(locale, await loadMessages(locale));

test("Plano ChatGPT em inglês: switch, conexão e botões", async () => {
	const html = await renderIn(
		"en-US",
		<ProvidersSettingsView busy={false} enabled={{ value: true, source: "env" }} onConnect={noop} onDisconnect={noop} onInherit={noop} onReload={noop} onToggle={noop} state="needs_login" status={null} />,
	);
	assert.match(html, /Use ChatGPT plan/);
	assert.match(html, /Inherited from the server default \(on\)\./);
	assert.match(html, /Reconnect ChatGPT/);
	assert.match(html, /Disconnect from account/);
	assert.doesNotMatch(html, /Usar plano|Herdado/);
});

test("Código do dispositivo e estados de conexão traduzidos", async () => {
	const html = await renderIn(
		"es-ES",
		<ProvidersSettingsView busy={false} device={{ userCode: "ABCD-1234", verificationUrl: "https://x.test", expiresAt: "" }} enabled={{ value: true, source: "user" }} onConnect={noop} onDisconnect={noop} onInherit={noop} onReload={noop} onToggle={noop} state="disconnected" status={null} />,
	);
	assert.match(html, /Escribe este código en ChatGPT/);
	assert.match(html, /aria-label="Código ABCD-1234"/);
	const en = await tr("en-US");
	assert.equal(providerConnectionLabel({ provider: "chatgpt", status: "connected", accountEmail: "a@b.c", updatedAt: null, lastLimitAt: null }, null, en), "Connected as a@b.c");
	assert.equal(providerConnectionLabel({ provider: "chatgpt", status: "needs_login", accountEmail: null, updatedAt: null, lastLimitAt: null, lastError: "device_expired" }, null, en), "The code expired. Generate a new code and try again.");
	assert.equal(chatgptSwitchHint({ value: false, source: "default" }, en), "Inherited from the account default (off).");
});

test("Chaves de API e e-mail dos bots em inglês", async () => {
	const keys = await renderIn("en-US", <ProviderKeyRow busy={false} onRemove={noop} onSave={noop} onTest={noop} provider="opencode-go" vaultReady={false} />);
	assert.match(keys, /Not connected/);
	assert.match(keys, /placeholder="Paste the key"/);
	assert.match(keys, /aria-label="API key: OpenCode Go"/);
	assert.match(keys, /Set CONNECTOR_ENCRYPTION_KEY/);
	const mail = await renderIn("en-US", <EmailKeyRow busy={false} onRemove={noop} onSave={noop} status={null} />);
	assert.match(mail, /Bot email/);
	assert.match(mail, /aria-label="API key: OpenMail"/);
});

const domain: EmailDomainDto = {
	id: "d1",
	domain: "acme.com",
	status: "pending",
	verified: false,
	records: [{ type: "MX", name: "@", value: "mx.test", priority: 10, valid: false }],
} as unknown as EmailDomainDto;

test("Domínio próprio em espanhol", async () => {
	const html = await renderIn("es-ES", <EmailDomainsPanel busyId={null} domains={[domain]} onAdd={async () => true} onRemove={noop} onVerify={noop} />);
	assert.match(html, /Dominio propio/);
	assert.match(html, /Pendiente/);
	assert.match(html, /Falta publicar/);
	assert.match(html, /aria-label="Copiar nombre"/);
	assert.match(html, /aria-label="Añadir dominio"/);
});

test("Notificações em inglês: estado, aparelhos e último uso", async () => {
	const now = Date.parse("2026-11-01T12:00:00Z");
	const html = await renderIn(
		"en-US",
		<NotificationsSettingsView currentDeviceId="d1" devices={[{ id: "d1", label: "Chrome", createdAt: "", lastUsedAt: "2026-11-01T11:30:00Z", failing: true }]} now={now} onDisable={noop} onEnable={noop} onRemove={noop} onTest={noop} state="on" />,
	);
	assert.match(html, /This device · .* · failing/);
	assert.match(html, /aria-label="Remove Chrome"/);
});

const catalog = [{ id: "acme/chat-only", name: "Acme: Chat", provider: "acme", contextLength: 1, inputModalities: ["text"], outputModalities: ["text"], supportedParameters: ["temperature"] }];
const resolved = (value: unknown, source = "default") => ({ value, source });
const effective = {
	models: {
		default: resolved("acme/chat-only"),
		fallbacks: resolved([]),
		maintenance: resolved(undefined),
		vision: resolved(undefined),
		image: resolved(undefined),
		coding: resolved(undefined),
		stt: resolved(undefined),
		tiers: resolved({}),
		classifyWithReviewer: resolved(false),
	},
} as unknown as EffectiveAccountConfig;

test("Modelos em inglês: rótulos, herdar e reservas", async () => {
	const html = await renderIn("en-US", <ModelsSettingsView effective={effective} models={catalog} onChange={noop} status="idle" />);
	assert.match(html, /Default model/);
	assert.match(html, /Model for reading images/);
	assert.match(html, /Inherit \(no fallback\)/);
	assert.match(html, /Fallback models/);
	assert.match(html, /Tried in order when the main model fails \(up to 3\)/);
	assert.doesNotMatch(html, /Modelo padrão|Herdar/);
});

test("Níveis de dificuldade em inglês", async () => {
	const html = await renderIn("en-US", <ModelTiersSettingsView effective={effective} models={catalog} onChange={noop} status="idle" />);
	assert.match(html, />Easy</);
	assert.match(html, /Conversation and short questions\./);
	assert.match(html, /Uses the default model\./);
	assert.match(html, /Classify with the reviewer/);
});

test("avisos de capacidade e rótulos de herança traduzidos", async () => {
	const es = await tr("es-ES");
	assert.match(modelSettingWarning("vision", "acme/chat-only", catalog as never, es) ?? "", /no lee imágenes/);
	assert.match(modelSettingWarning("maintenance", "acme/chat-only", catalog as never, es) ?? "", /no tiene herramientas/);
	assert.equal(dictationDefaultLabel("x/y", [], es), "Predeterminado (x/y)");
	assert.equal(maintenanceInheritLabel({ value: undefined, source: "default" }, { value: "chatgpt/x", source: "default" }, [], false, es), "Heredar (conecta una clave de proveedor)");
});
