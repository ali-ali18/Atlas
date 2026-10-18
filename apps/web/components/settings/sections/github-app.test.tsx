import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GithubAppInstallation, GithubAppStatus } from "@/lib/atlas-api";
import { SETTINGS_ITEMS, searchSettings } from "../settings-registry";
import { GithubAppSettingsView } from "./github-app";

Object.assign(globalThis, { React });

const noop = () => {};
const inst: GithubAppInstallation = {
	id: "i1",
	accountLogin: "acme",
	accountType: "Organization",
	repositorySelection: "selected",
	repoCount: 2,
	repos: [
		{ fullName: "acme/site", private: false },
		{ fullName: "acme/api", private: true },
	],
	suspended: false,
	manageUrl: "https://github.com/organizations/acme/settings/installations/7",
	createdAt: "2026-10-14T00:00:00.000Z",
};
const status: GithubAppStatus = {
	configured: true,
	isOwner: false,
	source: "db",
	slug: "meu-app",
	name: "Meu App",
	appUrl: "https://github.com/apps/meu-app",
	canVerifyInstall: true,
	webhookUrl: "https://app.exemplo.com/v1/github-app/webhook",
	defaultName: "Agente de Código 1a2b",
	signature: false,
	signatureText: null,
	missingWritePermissions: [],
	permissionsUrl: "https://github.com/apps/app",
	installations: [],
};

function view(props: Partial<React.ComponentProps<typeof GithubAppSettingsView>> = {}) {
	return renderToStaticMarkup(
		<GithubAppSettingsView busy={null} onRefresh={noop} onRemoveApp={noop} onUnlink={noop} status={status} {...props} />,
	);
}

test("carregando: não desenha nada", () => {
	assert.equal(view({ status: null }), "");
});

test("dono sem app: formulário GET para o manifest com nome sugerido e botão Criar GitHub App", () => {
	const html = view({ status: { ...status, configured: false, isOwner: true } });
	assert.match(html, /action="\/v1\/github-app\/manifest\/start"/);
	assert.match(html, /method="get"/);
	assert.match(html, /value="Agente de Código 1a2b"/);
	assert.match(html, /Criar GitHub App/);
});

test("usuário sem app: só avisa que o dono ainda não criou", () => {
	const html = view({ status: { ...status, configured: false } });
	assert.match(html, /O dono da instância ainda não criou/);
	assert.doesNotMatch(html, /Criar GitHub App/);
});

test("app criado sem instalação: botão Instalar no GitHub aponta para a rota de instalação", () => {
	const html = view();
	assert.match(html, /href="\/v1\/github-app\/install"/);
	assert.match(html, /Instalar no GitHub/);
	assert.doesNotMatch(html, /Remover app/);
});

test("instalado: conta, contagem, status, repositórios e Gerenciar no GitHub", () => {
	const html = view({ status: { ...status, installations: [inst] } });
	assert.match(html, /acme · Organização/);
	assert.match(html, /2 repositórios · Ativo/);
	assert.ok(html.includes("Repositórios (2)"));
	assert.ok(html.includes("Opções de acme"));
});

test("dono com app guardado vê webhook e Remover app; dono com app por env não remove", () => {
	const owner = { ...status, isOwner: true };
	const html = view({ status: owner });
	assert.match(html, /v1\/github-app\/webhook/);
	assert.ok(html.includes("Opções do app do GitHub"));
});

test("aviso de retorno e erro aparecem com o papel certo", () => {
	const html = view({ notice: { tone: "success", text: "GitHub conectado." }, error: "falhou" });
	assert.match(html, /role="status"/);
	assert.match(html, /role="alert"/);
});

test("a busca de configurações acha o GitHub pelos termos de instalar/criar app", () => {
	assert.ok(SETTINGS_ITEMS.some((item) => item.id === "github.app" && item.section === "conexoes"));
	assert.ok(searchSettings("github app").itemFilter.conexoes?.has("github.app"));
});

test("instalado: sem seletor de conta; diz que tudo sai como o bot do app", () => {
	const html = view({ status: { ...status, installations: [inst] } });
	assert.match(html, /data-slot="github-write-as"/);
	assert.ok(html.includes("meu-app[bot]"));
	assert.match(html, /nunca como a sua conta/);
	assert.doesNotMatch(html, /Minha conta|radiogroup|Escrever no GitHub como/);
});

test("app sem permissão de escrita: aviso com link para aceitar no GitHub", () => {
	const html = view({ status: { ...status, missingWritePermissions: ["issues"], installations: [inst] } });
	assert.match(html, /data-slot="github-permissions-warning"/);
	assert.match(html, /Issues/);
	assert.match(html, /Aceitar permissões no GitHub/);
	assert.match(html, /href="https:\/\/github.com\/organizations\/acme\/settings\/installations\/7"/);
	assert.doesNotMatch(view({ status: { ...status, installations: [inst] } }), /github-permissions-warning/);
});

test("assinatura no rodapé: desligada por padrão; ligada mostra o campo de texto", () => {
	const off = view({ status: { ...status, installations: [inst] } });
	assert.match(off, /Assinar no rodapé/);
	assert.doesNotMatch(off, /Texto da assinatura/);
	const on = view({ status: { ...status, signature: true, signatureText: "enviado pelo bot Cookie", installations: [inst] } });
	assert.match(on, /Texto da assinatura/);
	assert.match(on, /value="enviado pelo bot Cookie"/);
});
