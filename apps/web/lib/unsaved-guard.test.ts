import assert from "node:assert/strict";
import test from "node:test";
import { hasUnsavedChanges, registerUnsavedGuard, runUnlessUnsaved } from "./unsaved-guard";

test("sem guarda ou sem alterações, segue direto", () => {
	let ran = 0;
	runUnlessUnsaved(() => ran++);
	const off = registerUnsavedGuard({ isDirty: () => false, ask: () => assert.fail("não deve perguntar") });
	runUnlessUnsaved(() => ran++);
	assert.equal(ran, 2);
	assert.equal(hasUnsavedChanges(), false);
	off();
});

test("com alterações pergunta e só segue ao confirmar", () => {
	let ran = 0;
	const asked: Array<() => void> = [];
	const off = registerUnsavedGuard({ isDirty: () => true, ask: (proceed) => asked.push(proceed) });
	assert.equal(hasUnsavedChanges(), true);
	runUnlessUnsaved(() => ran++);
	assert.equal(ran, 0, "Esc/fechar fica parado até confirmar");
	asked[0]?.();
	assert.equal(ran, 1);
	off();
	assert.equal(hasUnsavedChanges(), false);
});

test("cancelar o registro antigo não derruba o guarda novo", () => {
	const offOld = registerUnsavedGuard({ isDirty: () => false, ask: () => {} });
	const offNew = registerUnsavedGuard({ isDirty: () => true, ask: () => {} });
	offOld();
	assert.equal(hasUnsavedChanges(), true);
	offNew();
});
