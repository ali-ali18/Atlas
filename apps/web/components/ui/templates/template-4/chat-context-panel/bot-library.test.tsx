import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotLibrary, BotLibraryList, LIBRARY_EMPTY_TEXT } from "./bot-library";

Object.assign(globalThis, { React });

test("biblioteca vazia mostra o texto de estado vazio", () => {
	const html = renderToStaticMarkup(<BotLibraryList files={[]} />);
	assert.ok(html.includes(LIBRARY_EMPTY_TEXT));
	assert.match(LIBRARY_EMPTY_TEXT, /PDF, Word, Excel, PowerPoint/);
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

const library = (routines: React.ComponentProps<typeof BotLibrary>["routines"] = []) =>
	renderToStaticMarkup(
		<BotLibrary
			active
			botId="b1"
			createRoutine={(trigger) => trigger}
			routines={routines}
			routinesBody={<p data-testid="routines-body">corpo das rotinas</p>}
		/>,
	);

const trigger = (html: string, id: string) => {
	const section = html.slice(html.indexOf(`data-library-section="${id}"`));
	return section.match(/<button[^>]*aria-expanded="(true|false)"[^>]*>/)?.[1];
};

test("seções recolhíveis: Páginas aberta por padrão; Documentos e Rotinas fechadas", () => {
	const html = library();
	assert.deepEqual(["pages", "documents", "routines"].map((id) => trigger(html, id)), ["true", "false", "false"]);
	const order = ["Páginas", "Documentos", "Rotinas"].map((title) => html.indexOf(`>${title}<`));
	assert.ok(order[0]! > 0 && order[0]! < order[1]! && order[1]! < order[2]!, "ordem das seções");
});

test("seção aberta mostra o conteúdo; fechada só o cabeçalho (gatilho é um botão com aria-controls)", () => {
	const html = library();
	assert.match(html, /data-testid="pages-loading"/, "Páginas aberta carrega a lista");
	assert.doesNotMatch(html, /corpo das rotinas/, "Rotinas fechada não monta o conteúdo");
	assert.doesNotMatch(html, /Ver mais|relatorio/, "Documentos fechada não monta a lista");
	assert.match(html, /<button[^>]*data-slot="collapsible-trigger"/);
});

test("o + de Rotinas só aparece quando já há rotinas, e fica fora do botão da seção", () => {
	assert.doesNotMatch(library(), /aria-label="Criar rotina"/);
	const html = library([{ id: "r1", name: "x", instruction: "y", model: "m", active: true, triggerKind: "cron", triggers: [] }]);
	assert.match(html, /aria-label="Criar rotina"/);
	assert.match(html, /<span[^>]*>1<\/span>/, "contagem no cabeçalho");
	const trig = html.match(/<button[^>]*data-slot="collapsible-trigger"[^>]*>[\s\S]*?<\/button>/g) ?? [];
	assert.ok(trig.every((markup) => !markup.includes('aria-label="Criar rotina"')), "sem botão dentro de botão");
});
