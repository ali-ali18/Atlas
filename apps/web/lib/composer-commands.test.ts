import assert from "node:assert/strict";
import test from "node:test";

import { composerCommandCandidates, resolveComposerCommand } from "./composer-commands";

const available = { compactAvailable: true, groupMode: false, hasAttachments: false };

test("o / oferece /compact com a descrição em português, só no chat 1:1 com tratador", () => {
	assert.deepEqual(composerCommandCandidates({ compactAvailable: true, groupMode: false }), [
		{ id: "command:compact", name: "compact", description: "Resume a conversa para liberar contexto", kind: "command" },
	]);
	assert.deepEqual(composerCommandCandidates({ compactAvailable: true, groupMode: true }), []);
	assert.deepEqual(composerCommandCandidates({ compactAvailable: false, groupMode: false }), []);
});

test("/compact e /compact <foco> viram ação; o resto é mensagem comum", () => {
	assert.deepEqual(resolveComposerCommand("/compact", available), { type: "compact" });
	assert.deepEqual(resolveComposerCommand("  /compact foque no pedido do Alfa ", available), { type: "compact", focus: "foque no pedido do Alfa" });
	for (const text of ["compact", "/compactar tudo", "oi /compact", "/skill-x faça", ""]) assert.equal(resolveComposerCommand(text, available), null);
});

test("com anexo, em grupo ou sem tratador, /compact segue como texto comum", () => {
	assert.equal(resolveComposerCommand("/compact", { ...available, hasAttachments: true }), null);
	assert.equal(resolveComposerCommand("/compact", { ...available, groupMode: true }), null);
	assert.equal(resolveComposerCommand("/compact", { ...available, compactAvailable: false }), null);
});
