import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PageShareBody, PUBLIC_LINK_WARNING, type ShareState } from "./page-share-dialog";

Object.assign(globalThis, { React });

const noop = () => undefined;
const render = (state: ShareState, copied = false) => renderToStaticMarkup(<PageShareBody busy={false} copied={copied} onCopy={noop} onRotate={noop} onToggle={noop} state={state} />);

test("link desativado: só o interruptor e a explicação, sem aviso nem endereço", () => {
	const html = render({ kind: "ready", active: false, url: null });
	assert.match(html, /aria-label="Link público"/);
	assert.match(html, /Desativado/);
	assert.doesNotMatch(html, /Desativar link/);
	assert.doesNotMatch(html, new RegExp(PUBLIC_LINK_WARNING));
});

test("link ativo recém-criado: aviso, endereço, copiar e desativar", () => {
	const html = render({ kind: "ready", active: true, url: "https://atlas.test/p/abc" });
	assert.match(html, /Qualquer pessoa com o link vê este painel e as atualizações dele\./);
	assert.match(html, /value="https:\/\/atlas.test\/p\/abc"/);
	assert.match(html, /Endereço do link público/);
	assert.match(html, /Copiar/);
	assert.match(html, /Desativar link/);
	assert.match(render({ kind: "ready", active: true, url: "https://atlas.test/p/abc" }, true), /Copiado/);
});

test("link ativo reaberto: sem endereço (o servidor só guarda o hash), oferece gerar novo", () => {
	const html = render({ kind: "ready", active: true, url: null });
	assert.doesNotMatch(html, /Endereço do link público/);
	assert.match(html, /Gerar novo link/);
	assert.match(html, /só aparece ao ser criado/);
});

test("carregando e erro", () => {
	assert.match(render({ kind: "loading" }), /share-loading/);
	assert.match(render({ kind: "error", message: "falhou" }), /role="alert"[^>]*>falhou/);
});
