import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CodeRunCard } from "./code-run-card";

Object.assign(globalThis, { React });

test("fechado: só o rótulo com o tempo", () => {
	const html = renderToStaticMarkup(<CodeRunCard code="print(1)" durationMs={1200} status="ok" />);
	assert.match(html, /Executou código · 1,2 s/);
	assert.match(html, /aria-expanded="false"/);
	assert.doesNotMatch(html, /print/);
});

test("aberto: código Python realçado e saída", () => {
	const html = renderToStaticMarkup(<CodeRunCard code={"x = 1\nprint(x)"} defaultOpen durationMs={800} output="1" status="ok" />);
	assert.match(html, /data-slot="code-block"/);
	assert.match(html, />python</);
	assert.match(html, /data-testid="code-run-output"/);
});

test("saída longa é truncada com mostrar tudo", () => {
	const output = Array.from({ length: 40 }, (_, i) => `linha ${i}`).join("\n");
	const html = renderToStaticMarkup(<CodeRunCard code="x" defaultOpen output={output} status="ok" />);
	assert.match(html, /mostrar tudo/);
	assert.doesNotMatch(html, /linha 39/);
});

test("falha em vermelho discreto e execução em andamento", () => {
	const fail = renderToStaticMarkup(<CodeRunCard code="x" durationMs={500} status="error" />);
	assert.match(fail, /Falhou · 0,5 s/);
	assert.match(fail, /text-destructive/);
	assert.match(renderToStaticMarkup(<CodeRunCard code="x" status="running" />), /Executando código…/);
});
