import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposioConnectedAppView, ComposioStatusView, ComposioToolkitView } from "@workspace/shared";
import {
	COMPOSIO_FIRST_PAGE,
	composioNextPage,
	availableToolkits,
	composioKeyCaption,
	composioViewState,
	isComposioConnectUrl,
	nativeToolkitNote,
} from "../composio-state";
import { SETTINGS_ITEMS, parseSettingsParam, searchSettings } from "../settings-registry";
import { ComposioSettingsView } from "./composio";

Object.assign(globalThis, { React });

const noop = () => {};
const off: ComposioStatusView = { configured: false, keyHint: null, secretBoxReady: true, toolCount: 0 };
const on: ComposioStatusView = { configured: true, keyHint: "••••9999", secretBoxReady: true, toolCount: 12 };
const trello: ComposioToolkitView = { slug: "trello", name: "Trello", description: "Quadros", logo: null, connected: false, noAuth: false, nativeCatalogId: null };
const github: ComposioToolkitView = { slug: "github", name: "GitHub", description: "Código", logo: null, connected: false, noAuth: false, nativeCatalogId: "github" };
const gmailConnected: ComposioToolkitView = { slug: "gmail", name: "Gmail", description: null, logo: null, connected: true, noAuth: false, nativeCatalogId: "gmail" };
const exa: ComposioToolkitView = { slug: "exa", name: "Exa", description: "Busca", logo: null, connected: false, noAuth: true, nativeCatalogId: null };
const exaApp: ComposioConnectedAppView = { id: "noauth_exa", toolkit: "exa", toolkitName: "Exa", noAuth: true };
const gmailApp: ComposioConnectedAppView = { id: "ca_1", toolkit: "gmail", toolkitName: "Gmail" };

function view(props: Partial<React.ComponentProps<typeof ComposioSettingsView>> = {}) {
	return renderToStaticMarkup(
		<ComposioSettingsView
			busy={null}
			connections={[]}
			onConnect={noop}
			onDisconnect={noop}
			onRemoveKey={noop}
			onSaveKey={noop}
			onSearch={noop}
			search=""
			status={off}
			toolkits={[]}
			{...props}
		/>,
	);
}

test("sem chave: só a linha da chave, com explicação e link para composio.dev", () => {
	const html = view();
	assert.match(html, /Chave do Composio/);
	assert.match(html, /Opcional/);
	assert.match(html, /href="https:\/\/composio\.dev"/);
	assert.match(html, /rel="noopener noreferrer"/);
	assert.match(html, /type="password"/);
	assert.doesNotMatch(html, /Adicionar app/);
	assert.doesNotMatch(html, /Conectar /);
});

test("com chave e mais páginas: o paginador compartilhado aparece nas Configurações", () => {
	const html = view({
		status: on,
		toolkits: [trello],
		paging: { pager: composioNextPage(COMPOSIO_FIRST_PAGE, "c2"), hasNext: true, totalItems: 48, loading: false, onPrev: noop, onNext: noop },
	});
	assert.match(html, /Paginação do catálogo do Composio/);
	assert.match(html, /Página 2 de 2/);
	assert.doesNotMatch(view({ status: on, toolkits: [trello] }), /Paginação do catálogo/);
});

test("carregando: não desenha nada", () => {
	assert.equal(view({ status: null }), "");
});

test("sem cofre: avisa e bloqueia o campo", () => {
	const html = view({ status: { ...off, secretBoxReady: false } });
	assert.match(html, /CONNECTOR_ENCRYPTION_KEY/);
	assert.match(html, /disabled/);
});

test("com chave e apps: máscara, busca, lista e botões de conectar", () => {
	const html = view({ status: on, toolkits: [trello, github] });
	assert.match(html, /••••9999/);
	assert.match(html, /12 ferramentas/);
	assert.match(html, /Remover chave/);
	assert.match(html, /Adicionar app/);
	assert.match(html, /Buscar apps/);
	assert.match(html, /aria-label="Conectar Trello"/);
	assert.match(html, /aria-label="Conectar GitHub"/);
	assert.match(html, /conector nativo/);
	assert.doesNotMatch(html, /type="password"/);
});

test("app conectado: selo e Desconectar; não repete na lista de adicionar", () => {
	const html = view({ status: on, connections: [gmailApp], toolkits: [gmailConnected, trello] });
	assert.match(html, /Conectado/);
	assert.match(html, /aria-label="Desconectar Gmail"/);
	assert.doesNotMatch(html, /aria-label="Conectar Gmail"/);
	assert.match(html, /aria-label="Conectar Trello"/);
});

test("erros e lista vazia aparecem como alerta", () => {
	const html = view({ status: on, error: "Chave do Composio recusada", listError: "Falhou ao listar" });
	assert.match(html, /role="alert"/);
	assert.match(html, /Chave do Composio recusada/);
	assert.match(html, /Falhou ao listar/);
	assert.match(view({ status: on }), /Nenhum app encontrado/);
});

test("ocupado desabilita os botões e mostra Aguarde", () => {
	const html = view({ status: on, toolkits: [trello], busy: "trello" });
	assert.match(html, /Aguarde…/);
});

test("a chave nunca aparece no HTML", () => {
	assert.doesNotMatch(view({ status: on }), /cmp_/);
});

test("estado puro da seção", () => {
	assert.equal(composioViewState(null), "loading");
	assert.equal(composioViewState(off), "off");
	assert.equal(composioViewState(on), "on");
	assert.equal(composioKeyCaption({ ...on, toolCount: 0 }), "Chave salva (••••9999). Conecte um app para liberar ferramentas.");
	assert.match(composioKeyCaption({ ...on, toolCount: 1 }), /1 ferramenta disponíveis/);
	assert.deepEqual(availableToolkits([trello, gmailConnected, github], [gmailApp]).map((t) => t.slug), ["trello", "github"]);
	assert.equal(nativeToolkitNote(trello), null);
	assert.ok(nativeToolkitNote(github));
});

test("só abre o login em composio.dev", () => {
	assert.equal(isComposioConnectUrl("https://connect.composio.dev/link/ln_1"), true);
	assert.equal(isComposioConnectUrl("https://composio.dev/x"), true);
	assert.equal(isComposioConnectUrl("http://connect.composio.dev/link"), false);
	assert.equal(isComposioConnectUrl("https://evilcomposio.dev/link"), false);
	assert.equal(isComposioConnectUrl("https://composio.dev.evil.com/x"), false);
	assert.equal(isComposioConnectUrl("javascript:alert(1)"), false);
});

test("registro: Composio mora em Conexões, o link antigo abre lá e a busca acha", () => {
	assert.equal(parseSettingsParam("composio"), "conexoes");
	assert.ok(searchSettings("composio").entries.some((item) => item.id === "conexoes"));
	assert.ok(searchSettings("api key").entries.some((item) => item.id === "conexoes"));
	assert.ok(SETTINGS_ITEMS.some((item) => item.id === "composio.chave" && item.section === "conexoes"));
});

test("logo real recebido do Composio aparece no app", () => {
	const html = view({ status: on, toolkits: [{ ...trello, logo: "https://logos.example/trello.svg" }] });
	assert.match(html, /<img[^>]+src="https:\/\/logos\.example\/trello\.svg"/);
	assert.match(html, /referrerPolicy="no-referrer"/);
});

test("app sem login: selo \"Sem login\" e Ativar, nunca Conectar", () => {
	const html = view({ status: on, toolkits: [exa, trello] });
	assert.match(html, /Sem login/);
	assert.match(html, /aria-label="Ativar Exa"/);
	assert.doesNotMatch(html, /aria-label="Conectar Exa"/);
	assert.match(html, /aria-label="Conectar Trello"/);
	assert.equal(html.match(/Sem login/g)?.length, 1, "só o app sem login ganha o selo");
});

test("app sem login ativado: Ativado e Desativar", () => {
	const html = view({ status: on, connections: [exaApp], toolkits: [{ ...exa, connected: true }] });
	assert.match(html, /Ativado/);
	assert.match(html, /aria-label="Desativar Exa"/);
	assert.doesNotMatch(html, /Desconectar Exa/);
	assert.doesNotMatch(html, /aria-label="Ativar Exa"/);
});
