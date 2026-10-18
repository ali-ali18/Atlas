import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Routine } from "../data";
import { RoutineEditor } from "./routine-editor";

Object.assign(globalThis, { React });

const draft: Routine = {
	id: "draft-1",
	name: "",
	instruction: "",
	active: true,
	model: "m",
	triggerKind: "event",
	triggers: [{ id: "webhook", text: "Webhook" }],
};

test("rascunho mostra 'Criar rotina' desabilitado até ter nome e instrução", () => {
	const saves: Routine[] = [];
	const creates: Routine[] = [];
	const html = renderToStaticMarkup(
		<RoutineEditor
			onCreate={(r) => {
				creates.push(r);
				return true;
			}}
			onSave={(r) => void saves.push(r)}
			routine={draft}
		/>,
	);
	assert.match(html, /<button[^>]*disabled=""[^>]*>Criar rotina<\/button>/);
	assert.match(html, /gerados ao criar a rotina/);
	// Renderizar nunca cria nem salva.
	assert.equal(creates.length, 0);
	assert.equal(saves.length, 0);
});

test("rascunho válido habilita 'Criar rotina' (ainda sem criar)", () => {
	const creates: Routine[] = [];
	const html = renderToStaticMarkup(
		<RoutineEditor
			onCreate={(r) => {
				creates.push(r);
				return true;
			}}
			routine={{ ...draft, name: "Deploy", instruction: "Faça deploy" }}
		/>,
	);
	assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Criar rotina<\/button>/);
	assert.match(html, />Criar rotina<\/button>/);
	assert.equal(creates.length, 0);
});

test("rotina criada não mostra 'Criar rotina' e exibe URL + secret", () => {
	const html = renderToStaticMarkup(
		<RoutineEditor
			oneTimeSecret="s3cr3t"
			persisted
			routine={{
				...draft,
				id: "srv-1",
				name: "Deploy",
				instruction: "x",
				hook: { hookKey: "k", url: "https://x.test/v1/hooks/k" },
			}}
		/>,
	);
	assert.doesNotMatch(html, />Criar rotina</);
	assert.match(html, /https:\/\/x\.test\/v1\/hooks\/k/);
	assert.match(html, /s3cr3t/);
});
