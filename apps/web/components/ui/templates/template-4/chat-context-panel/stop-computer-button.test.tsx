import React from "react";
Object.assign(globalThis, { React });
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StopComputerButton, stopComputerLabel } from "./stop-computer-button";

test("o botão tem nome acessível com o bot e o texto em português", () => {
	const html = renderToStaticMarkup(<StopComputerButton agentName="Atlas" onStop={() => undefined} />);
	assert.match(html, /aria-label="Desligar o computador de Atlas"/);
	assert.match(html, /Desligar computador/);
	assert.doesNotMatch(html, /disabled=/);
});

test("desligando: botão travado e texto de andamento; falha mostra aviso", () => {
	assert.equal(stopComputerLabel(true), "Desligando…");
	const html = renderToStaticMarkup(<StopComputerButton agentName="Atlas" busy error="Não consegui desligar agora." onStop={() => undefined} />);
	assert.match(html, /disabled=/);
	assert.match(html, /role="alert"/);
	assert.match(html, /Não consegui desligar agora\./);
});
