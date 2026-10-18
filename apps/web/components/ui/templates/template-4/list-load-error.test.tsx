import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LIST_ERROR_RETRY, LIST_ERROR_TITLE, ListLoadError, listErrorMode } from "./list-load-error";

Object.assign(globalThis, { React });

test("erro sem lista vira tela de erro, não 'nenhuma conversa'", () => {
	assert.equal(listErrorMode({ loadError: true, loading: false, count: 0 }), "full");
	const html = renderToStaticMarkup(<ListLoadError mode="full" onRetry={() => {}} />);
	assert.match(html, new RegExp(LIST_ERROR_TITLE));
	assert.match(html, new RegExp(LIST_ERROR_RETRY));
	assert.doesNotMatch(html, /Nenhuma conversa ainda|Criar agente/);
});

test("erro com lista conhecida mantém a lista e mostra só uma faixa", () => {
	assert.equal(listErrorMode({ loadError: true, loading: false, count: 4 }), "banner");
	const html = renderToStaticMarkup(<ListLoadError mode="banner" onRetry={() => {}} />);
	assert.match(html, /role="status"/);
	assert.match(html, /Mostrando a última lista/);
});

test("sem erro ou ainda carregando: nada de aviso (vazio de verdade continua sendo vazio)", () => {
	assert.equal(listErrorMode({ loadError: false, loading: false, count: 0 }), "none");
	assert.equal(listErrorMode({ loadError: true, loading: true, count: 0 }), "none");
});
