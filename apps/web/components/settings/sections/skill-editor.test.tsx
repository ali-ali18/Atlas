import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_SKILL_FORM, type SkillForm } from "../skills-state";
import { SkillEditorView, type SkillEditorViewProps } from "./skills/skill-editor-view";

Object.assign(globalThis, { React });

const noop = () => {};

function renderEditor(props: Partial<SkillEditorViewProps> = {}, form: Partial<SkillForm> = {}) {
	return renderToStaticMarkup(
		<SkillEditorView
			bots={[{ id: "b1", name: "Ana" }]}
			errors={{}}
			form={{ ...EMPTY_SKILL_FORM, ...form }}
			mode="create"
			onCancel={noop}
			onChange={noop}
			onSave={noop}
			onTabChange={noop}
			tab="edit"
			{...props}
		/>,
	);
}

test("editor: campos, contadores e abas Editar/Prévia", () => {
	const html = renderEditor({}, { description: "abc", body: "# oi" });
	assert.match(html, /Nova habilidade/);
	assert.match(html, /for="skill-name"/);
	assert.match(html, />3\/300</);
	assert.match(html, /0,0 de 16 KB/);
	assert.match(html, /role="tablist"/);
	assert.match(html, /aria-selected="true"[^>]*>Editar</);
	assert.match(html, /aria-selected="false"[^>]*>Prévia</);
	assert.match(html, /<textarea[^>]*font-mono/);
	assert.match(html, /aria-label="Voltar para a lista de habilidades"/);
	assert.match(html, />Salvar</);
});

test("editor: mensagens de validação ligadas aos campos", () => {
	const html = renderEditor({
		errors: { name: "O nome é obrigatório.", description: "A descrição é obrigatória.", body: "O corpo da skill não pode ficar vazio." },
	});
	assert.match(html, /O nome é obrigatório\./);
	assert.match(html, /A descrição é obrigatória\./);
	assert.match(html, /O corpo da skill não pode ficar vazio\./);
	assert.match(html, /aria-invalid="true"/);
	assert.match(html, /aria-describedby="skill-name-error"/);
});

test("editor: erro da API (409/413) aparece como alerta e salvar trava ao salvar", () => {
	const html = renderEditor({ saveError: "Já existe uma skill chamada &quot;x&quot;.", saving: true });
	assert.match(html, /role="alert"/);
	assert.match(html, /Já existe uma skill/);
	assert.match(html, /disabled=""[^>]*>Salvando…</);
});

test("editor: aba Prévia renderiza o markdown sem HTML cru", () => {
	const html = renderEditor(
		{ tab: "preview" },
		{ body: "# Título\n\n- item\n\n<script>alert(1)</script>\n\n`codigo`" },
	);
	assert.match(html, /<h1[^>]*>Título<\/h1>/);
	assert.match(html, /<li[^>]*>item<\/li>/);
	assert.match(html, /<code[^>]*>codigo<\/code>/);
	assert.doesNotMatch(html, /<script>/);
	assert.doesNotMatch(html, /<textarea/);
	assert.match(renderEditor({ tab: "preview" }), /Nada para visualizar ainda/);
});

test("editor: edição trava o escopo e conta acima de 16 KB fica em erro", () => {
	const edit = renderEditor({ mode: "edit" }, { botId: "b1" });
	assert.match(edit, /Editar habilidade/);
	assert.match(edit, /O escopo não muda depois de criada/);
	assert.match(edit, /disabled=""[^>]*data-slot="settings-picker-trigger"|data-slot="settings-picker-trigger"[^>]*disabled=""/);
	const big = renderEditor({}, { body: "a".repeat(17 * 1024) });
	assert.match(big, /text-destructive[^>]*>17,0 de 16 KB/);
});
