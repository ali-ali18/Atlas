import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotLibraryList, LIBRARY_EMPTY_TEXT } from "./bot-library";

Object.assign(globalThis, { React });

test("biblioteca vazia mostra o texto de estado vazio", () => {
	const html = renderToStaticMarkup(<BotLibraryList files={[]} />);
	assert.ok(html.includes(LIBRARY_EMPTY_TEXT));
});

test("biblioteca lista nome, tamanho, versão e link de download dos arquivos", () => {
	const html = renderToStaticMarkup(
		<BotLibraryList
			files={[
				{ id: "a1", filename: "relatorio.pdf", size: 2048, version: 2, mime: "application/pdf", createdAt: "2026-01-01T00:00:00.000Z" },
				{ id: "a2", filename: "dados.xlsx", size: 100, version: 1, mime: "application/x", createdAt: "2026-01-01T00:00:00.000Z" },
				{ id: "a3", filename: "nota.txt", size: 5, version: 1, mime: "text/plain", createdAt: "2026-01-01T00:00:00.000Z" },
			]}
			hasMore
		/>,
	);
	assert.match(html, /relatorio\.pdf/);
	assert.match(html, /dados\.xlsx/);
	assert.match(html, /nota\.txt/);
	assert.match(html, /PDF · 2 KB · v2/);
	assert.match(html, /\/v1\/files\/a1/);
	assert.match(html, /Ver mais/);
	assert.doesNotMatch(html, new RegExp(LIBRARY_EMPTY_TEXT));
});
