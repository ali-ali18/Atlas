import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderStatus, Resolved } from "@workspace/shared";
import {
	canDisconnect,
	chatgptSwitchHint,
	providerConnectionLabel,
	providersViewState,
} from "../providers-state";
import { ProvidersSettingsView } from "./providers";

Object.assign(globalThis, { React });

const noop = () => {};
const status = (value: ProviderStatus["status"], accountEmail: string | null = null): ProviderStatus => ({
	provider: "chatgpt",
	status: value,
	accountEmail,
	updatedAt: null,
	lastLimitAt: null,
});
const on: Resolved<boolean> = { value: true, source: "user" };
const off: Resolved<boolean> = { value: false, source: "user" };

function view(props: Partial<React.ComponentProps<typeof ProvidersSettingsView>> = {}) {
	const enabled = "enabled" in props ? props.enabled! : on;
	const st = "status" in props ? props.status! : null;
	return renderToStaticMarkup(
		<ProvidersSettingsView
			busy={false}
			enabled={enabled}
			onConnect={noop}
			onDisconnect={noop}
			onInherit={noop}
			onReload={noop}
			onToggle={noop}
			state={providersViewState({ enabled, isOwner: true, status: st })}
			status={st}
			{...props}
		/>,
	);
}

test("estado: dono, plano e conexão definem a tela", () => {
	const base = { isOwner: true as boolean | null, error: null };
	assert.equal(providersViewState({ ...base, enabled: null, status: null }), "loading");
	assert.equal(providersViewState({ ...base, isOwner: null, enabled: on, status: null }), "loading");
	assert.equal(providersViewState({ ...base, isOwner: false, enabled: on, status: status("connected") }), "hidden");
	assert.equal(providersViewState({ ...base, enabled: off, status: status("connected") }), "off");
	assert.equal(providersViewState({ ...base, enabled: on, status: null }), "disconnected");
	assert.equal(providersViewState({ ...base, enabled: on, status: status("needs_login") }), "needs_login");
	assert.equal(providersViewState({ ...base, enabled: on, status: status("connected") }), "connected");
	assert.equal(providersViewState({ ...base, enabled: on, status: status("error") }), "error");
	assert.equal(providersViewState({ ...base, enabled: on, status: null, error: "falhou" }), "error");
});

test("desconectado: switch ligado, botão Conectar ChatGPT e nada de Desconectar da conta", () => {
	const html = view({ status: status("disconnected") });
	assert.match(html, /Usar plano ChatGPT/);
	assert.match(html, /role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/);
	assert.match(html, />Conectar ChatGPT</);
	assert.match(html, /Não conectado/);
	assert.doesNotMatch(html, /Desconectar da conta/);
});

test("conectado: mostra o e-mail e a ação Desconectar da conta, sem botão Conectar", () => {
	const html = view({ status: status("connected", "ana@example.com") });
	assert.match(html, /Conectado como ana@example\.com/);
	assert.match(html, /Desconectar da conta/);
	assert.doesNotMatch(html, />Conectar ChatGPT</);
});

test("precisa reconectar: botão Reconectar ChatGPT", () => {
	assert.match(view({ status: status("needs_login") }), />Reconectar ChatGPT</);
});

test("switch desligado: sem Conectar, avisa que os tokens ficam e ainda permite Desconectar da conta", () => {
	const html = view({ enabled: off, status: null });
	assert.match(html, /aria-checked="false"/);
	assert.match(html, /Plano desligado\. A conexão e os tokens ficam guardados/);
	assert.doesNotMatch(html, />Conectar ChatGPT</);
	assert.match(html, />Desconectar da conta</);
});

test("switch desligado pelo padrão (não por você) não oferece Desconectar da conta", () => {
	const html = view({ enabled: { value: false, source: "env" } });
	assert.doesNotMatch(html, /Desconectar da conta/);
	assert.equal(canDisconnect("off", "env"), false);
	assert.equal(canDisconnect("off", "user"), true);
	assert.equal(canDisconnect("disconnected", "user"), false);
});

test("não-dono: a seção não renderiza nada", () => {
	const html = renderToStaticMarkup(
		<ProvidersSettingsView
			busy={false}
			enabled={on}
			onConnect={noop}
			onDisconnect={noop}
			onInherit={noop}
			onReload={noop}
			onToggle={noop}
			state={providersViewState({ enabled: on, isOwner: false, status: status("connected") })}
			status={status("connected")}
		/>,
	);
	assert.equal(html, "");
});

test("origem herdada aparece sob o switch; valor do usuário oferece Voltar ao padrão", () => {
	assert.match(chatgptSwitchHint({ value: false, source: "env" }), /Herdado do padrão do servidor \(desligado\)/);
	assert.match(chatgptSwitchHint({ value: true, source: "default" }), /Herdado do padrão da conta \(ligado\)/);
	assert.equal(chatgptSwitchHint(on), "Definido por você.");
	assert.match(view({ enabled: { value: false, source: "env" } }), /Herdado do padrão do servidor \(desligado\)/);
	assert.doesNotMatch(view({ enabled: { value: false, source: "env" } }), /Voltar ao padrão/);
	assert.match(view({ status: status("connected") }), /Voltar ao padrão/);
});

test("carregando: switch desabilitado e sem linhas de conexão", () => {
	const html = renderToStaticMarkup(
		<ProvidersSettingsView
			busy={false}
			enabled={null}
			onConnect={noop}
			onDisconnect={noop}
			onInherit={noop}
			onReload={noop}
			onToggle={noop}
			state="loading"
			status={null}
		/>,
	);
	assert.match(html, /data-disabled/);
	assert.doesNotMatch(html, /Conexão com o ChatGPT/);
});

test("erro: mostra o alerta com Tentar novamente; busca esconde o que não casou", () => {
	const html = view({ error: "Não foi possível carregar o ChatGPT. Tente novamente.", status: null });
	assert.match(html, /role="alert"/);
	assert.match(html, /Tentar novamente/);
	const filtered = view({ status: status("connected"), isVisible: (id) => id === "provedores.chatgpt" });
	assert.match(filtered, /Usar plano ChatGPT/);
	assert.doesNotMatch(filtered, /Desconectar da conta/);
});

test("rótulo da conexão: 503 não se apresenta como desconexão normal", () => {
	assert.equal(providerConnectionLabel(null, "Falha segura"), "ChatGPT temporariamente indisponível");
	assert.equal(providerConnectionLabel(null), "Não conectado");
});

test("needs_login com código específico mostra a mensagem curta em pt-BR", () => {
	assert.equal(
		providerConnectionLabel({
			...status("needs_login"),
			lastError: "invalid_token_response:scope_missing_plan",
		}),
		"A conta não concedeu o uso do plano. Conecte de novo e aceite o acesso.",
	);
	assert.equal(providerConnectionLabel({ ...status("needs_login"), lastError: "needs_login" }), "Reconecte o ChatGPT");
});

test("login por código: mostra o código, abrir página e aguardando; esconde Conectar", () => {
	const html = view({
		status: status("disconnected"),
		device: { userCode: "ABCD-12345", verificationUrl: "https://auth.openai.com/codex/device", expiresAt: "2030-01-01T00:00:00.000Z" },
	});
	assert.match(html, /ABCD-12345/);
	assert.match(html, /Copiar código/);
	assert.match(html, /Abrir página de login/);
	assert.match(html, /Aguardando confirmação/);
	assert.doesNotMatch(html, /Conectar ChatGPT/);
});

test("login por código expirado oferece gerar novo código", () => {
	const html = view({ status: status("disconnected"), expired: true });
	assert.match(html, /O código expirou/);
	assert.match(html, /Gerar novo código/);
});
