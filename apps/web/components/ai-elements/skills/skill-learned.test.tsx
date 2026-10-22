import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillLearnedCard, learnedTitle } from "./skill-learned";

Object.assign(globalThis, { React });

test("título: criada vira 'Aprendi: nome', atualizada vira 'Atualizei a skill nome'", () => {
	assert.equal(learnedTitle("created", "pesquisa-de-mercado"), "Aprendi: pesquisa-de-mercado");
	assert.equal(learnedTitle("updated", "pesquisa-de-mercado"), "Atualizei a skill pesquisa-de-mercado");
});

test("aviso é só um marcador, sem botão nem ação", () => {
	const html = renderToStaticMarkup(<SkillLearnedCard action="created" name="relatorio" />);
	assert.match(html, /data-slot="marker-content"/);
	assert.match(html, /Aprendi: relatorio/);
	assert.doesNotMatch(html, /<button|Desfazer|ver</);
});
