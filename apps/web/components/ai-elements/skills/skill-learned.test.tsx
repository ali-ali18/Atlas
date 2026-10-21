import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillLearnedCard, learnedTitle, undoErrorMessage } from "./skill-learned";

Object.assign(globalThis, { React });

test("título: criada vira 'Aprendi: nome', atualizada vira 'Atualizei a skill nome'", () => {
	assert.equal(learnedTitle("created", "pesquisa-de-mercado"), "Aprendi: pesquisa-de-mercado");
	assert.equal(learnedTitle("updated", "pesquisa-de-mercado"), "Atualizei a skill pesquisa-de-mercado");
});

test("card mostra o aviso, o resumo e o botão Desfazer", () => {
	const html = renderToStaticMarkup(<SkillLearnedCard action="created" name="relatorio" onUndo={async () => undefined} summary="Gera o relatório semanal" />);
	assert.match(html, /Aprendi: relatorio/);
	assert.match(html, /Gera o relatório semanal/);
	assert.match(html, />Desfazer</);
});

test("já desfeito: sem botão e com a legenda", () => {
	const html = renderToStaticMarkup(<SkillLearnedCard action="updated" name="relatorio" onUndo={async () => undefined} undone />);
	assert.doesNotMatch(html, />Desfazer</);
	assert.match(html, /Desfeito\./);
});

test("sem handler não há botão", () => {
	assert.doesNotMatch(renderToStaticMarkup(<SkillLearnedCard action="created" name="x" />), />Desfazer</);
});

test("erros do desfazer em pt-BR por status", () => {
	assert.match(undoErrorMessage({ status: 404 }), /não existe mais/);
	assert.equal(undoErrorMessage(Object.assign(new Error("A skill foi alterada depois."), { status: 409 })), "A skill foi alterada depois.");
	assert.match(undoErrorMessage(new Error("x")), /Tente de novo/);
});
