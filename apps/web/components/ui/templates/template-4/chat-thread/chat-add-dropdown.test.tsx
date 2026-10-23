import assert from "node:assert/strict";
import test from "node:test";

import { addDropdownRows } from "./chat-add-dropdown";
import { addMenuVariant } from "./chat-add-menu";

test("variante do menu: gaveta no celular e dropdown compacto no desktop", () => {
	assert.equal(addMenuVariant(true), "drawer");
	assert.equal(addMenuVariant(false), "dropdown");
});

test("dropdown desktop: Fotos, Arquivo, PR, Skill e Permissão com o modo atual", () => {
	assert.deepEqual(addDropdownRows({ onPickFile: () => undefined, showTestPr: true, permission: { mode: "allowlist", onChange: () => undefined } }), [
		"Fotos",
		"Arquivo",
		"Testar uma PR",
		"Skill",
		"Permissão: Lista liberada",
	]);
	assert.deepEqual(addDropdownRows({ showTestPr: false }), ["Fotos", "Skill"]);
});
