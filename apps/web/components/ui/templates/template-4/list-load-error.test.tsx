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

test("o erro da lista sai no idioma da interface", async () => {
	const { I18nProvider } = await import("@/lib/i18n/provider");
	const { loadMessages } = await import("@/lib/i18n/messages");
	const en = renderToStaticMarkup(
		<I18nProvider locale="en-US" messages={await loadMessages("en-US")}>
			<ListLoadError mode="full" onRetry={() => {}} />
			<ListLoadError mode="banner" onRetry={() => {}} />
		</I18nProvider>,
	);
	assert.match(en, /Couldn&#x27;t load your conversations\./);
	assert.match(en, /Showing the last list/);
	assert.match(en, />\s*Try again/);
	assert.doesNotMatch(en, /Tentar de novo|conversas/);
	const es = renderToStaticMarkup(
		<I18nProvider locale="es-ES" messages={await loadMessages("es-ES")}>
			<ListLoadError mode="full" onRetry={() => {}} />
		</I18nProvider>,
	);
	assert.match(es, /No se han podido cargar tus conversaciones/);
});
