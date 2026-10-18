import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AddMenuPanel, type AddMenuPanelProps } from "./chat-add-menu";

Object.assign(globalThis, { React });

const base: AddMenuPanelProps = {
	step: "root",
	onStep: () => undefined,
	onClose: () => undefined,
	onPickPhotos: () => undefined,
	showTestPr: true,
	onTestPr: () => undefined,
	onPickSkill: () => undefined,
	skills: [
		{ id: "s1", name: "Resumir texto", slug: "resumir-texto", description: "", factory: false },
		{ id: "builtin:codigo", name: "Sessões de código", slug: "codigo", description: "", factory: true },
	],
	skillsLoading: false,
	permission: { mode: "allowlist", onChange: () => undefined },
	showClose: true,
};
const html = (props: Partial<AddMenuPanelProps> = {}) => renderToStaticMarkup(<AddMenuPanel {...base} {...props} />);

test("raiz: cabeçalho com X, tiles de anexo e as linhas Testar uma PR, Skill e Permissão com o modo", () => {
	const out = html({ onTakePhoto: () => undefined });
	assert.match(out, />Adicionar</);
	assert.match(out, /aria-label="Fechar"/);
	assert.match(out, />Câmera</);
	assert.match(out, />Fotos</);
	assert.match(out, />Testar uma PR</);
	assert.match(out, />Skill</);
	assert.match(out, />Permissão</);
	assert.match(out, />Lista liberada</);
});

test("sem sessões de código: sem Testar uma PR nem Permissão; sem câmera no desktop", () => {
	const out = html({ showTestPr: false, permission: undefined, showClose: false });
	assert.doesNotMatch(out, /Testar uma PR/);
	assert.doesNotMatch(out, /Permissão/);
	assert.doesNotMatch(out, />Câmera</);
	assert.doesNotMatch(out, /aria-label="Fechar"/);
});

test("passo Skill: voltar, grupo das minhas e De fábrica (lista real, não fixa)", () => {
	const out = html({ step: "skills" });
	assert.match(out, /aria-label="Voltar"/);
	assert.match(out, /Minhas skills/);
	assert.match(out, />Resumir texto</);
	assert.match(out, />De fábrica</);
	assert.match(out, />Sessões de código</);
	assert.doesNotMatch(out, /Traduzir|Criar skill/);
	assert.match(html({ step: "skills", skills: [], skillsLoading: true }), /Carregando/);
	assert.match(html({ step: "skills", skills: [] }), /Nenhuma skill disponível/);
});

test("passo Permissão: os três modos, o atual marcado", () => {
	const out = html({ step: "permission" });
	for (const label of ["Perguntar sempre", "Lista liberada", "Automático"]) assert.match(out, new RegExp(label));
	assert.equal((out.match(/aria-label="Selecionado"/g) ?? []).length, 1);
});
