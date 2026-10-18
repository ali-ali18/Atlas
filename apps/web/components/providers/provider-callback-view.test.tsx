import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { providerErrorMessage } from "@workspace/shared";
import { ProviderCallbackView } from "./provider-callback-view";

Object.assign(globalThis, { React });

const render = (props: Partial<React.ComponentProps<typeof ProviderCallbackView>>) =>
	renderToStaticMarkup(<ProviderCallbackView state="working" hasOpener {...props} />);

test("conectando: logos, pontos animados, spinner e região viva", () => {
	const html = render({ state: "working" });
	assert.match(html, /Conectando ao ChatGPT…/);
	assert.match(html, /aria-label="ChatGPT"/);
	assert.match(html, /aria-label="App"/);
	assert.match(html, /animate-pulse/);
	assert.match(html, /animate-spin/);
	assert.match(html, /aria-live="polite"/);
	assert.match(html, /fill="currentColor"/);
	assert.doesNotMatch(html, /Tentar de novo|Voltar ao app/);
});

test("sucesso: título, e-mail da conta e aviso para fechar", () => {
	const html = render({ state: "success", email: "ana@example.com" });
	assert.match(html, /ChatGPT conectado/);
	assert.match(html, /ana@example\.com/);
	assert.match(html, /Você já pode fechar esta janela/);
	assert.doesNotMatch(html, /animate-pulse|animate-spin|Voltar ao app/);
});

test("sucesso sem e-mail não inventa conta", () => {
	const html = render({ state: "success", email: null });
	assert.doesNotMatch(html, /@/);
});

test("erro com código: mensagem mapeada, Tentar de novo e Fechar", () => {
	const message = providerErrorMessage("invalid_token_response:scope_missing_plan");
	const html = render({ state: "error", message });
	assert.match(html, /Não foi possível conectar/);
	assert.match(html, /A conta não concedeu o uso do plano/);
	assert.match(html, />Tentar de novo</);
	assert.match(html, />Fechar</);
});

test("sem opener: link Voltar ao app (Geral) e sem Tentar de novo", () => {
	const html = render({ state: "error", message: "falhou", hasOpener: false });
	assert.match(html, /href="\/\?settings=provedores"/);
	assert.match(html, />Voltar ao app</);
	assert.doesNotMatch(html, /Tentar de novo/);
	assert.match(render({ state: "success", hasOpener: false }), />Voltar ao app</);
	assert.doesNotMatch(render({ state: "working", hasOpener: false }), /Voltar ao app/);
});
