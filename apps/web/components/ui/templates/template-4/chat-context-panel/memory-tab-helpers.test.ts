import assert from "node:assert/strict";
import test from "node:test";
import {
	memoryChangeOriginLabel,
	memoryChangeScope,
	memoryChangeVerb,
	memoryFixDraft,
	memoryOriginLabel,
	memoryRelativeDate,
	memoryUndoState,
} from "./memory-tab-helpers";

test("origem da memória: conversa, revisão da conversa, reflexão diária ou você", () => {
	assert.equal(memoryOriginLabel("agent-tool"), "Da conversa");
	assert.equal(memoryOriginLabel(null), "Da conversa");
	assert.equal(memoryOriginLabel("memory-review"), "Revisão da conversa");
	assert.equal(memoryOriginLabel("reflexao: diária"), "Reflexão diária");
	assert.equal(memoryOriginLabel("user"), "Você adicionou");
});

test("origem de uma mudança do histórico", () => {
	assert.equal(memoryChangeOriginLabel("chat"), "Da conversa");
	assert.equal(memoryChangeOriginLabel("reflection"), "Reflexão diária");
	assert.equal(memoryChangeOriginLabel("review"), "Revisão da conversa");
	assert.equal(memoryChangeOriginLabel("user"), "Você");
});

test("data relativa nas faixas: agora, minutos, horas, ontem, dias e data", () => {
	const now = new Date("2026-10-15T12:00:00.000Z");
	const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
	assert.equal(memoryRelativeDate(ago(10_000), now), "agora");
	assert.equal(memoryRelativeDate(ago(5 * 60_000), now), "há 5 min");
	assert.equal(memoryRelativeDate(ago(3 * 3_600_000), now), "há 3 h");
	assert.equal(memoryRelativeDate(ago(30 * 3_600_000), now), "ontem");
	assert.equal(memoryRelativeDate(ago(4 * 86_400_000), now), "há 4 dias");
	assert.equal(memoryRelativeDate(ago(20 * 86_400_000), now, "UTC"), "25 de set.");
	assert.equal(memoryRelativeDate("lixo", now), "");
	// Relógio adiantado não gera "há -1 min".
	assert.equal(memoryRelativeDate(new Date(now.getTime() + 60_000).toISOString(), now), "agora");
});

test("rascunho de 'Corrigir no chat' termina em travessão para a pessoa continuar", () => {
	assert.equal(memoryFixDraft("Mora em Recife"), 'Sobre o que você lembra: "Mora em Recife" — ');
	assert.equal(memoryFixDraft("  com espaços  "), 'Sobre o que você lembra: "com espaços" — ');
});

test("estado do desfazer: disponível, já desfeito ou um desfazer (não se desfaz)", () => {
	assert.equal(memoryUndoState({ undoneAt: null, undoOfId: null }), "available");
	assert.equal(memoryUndoState({ undoneAt: "2026-10-15T10:00:00.000Z", undoOfId: null }), "undone");
	assert.equal(memoryUndoState({ undoneAt: null, undoOfId: "c1" }), "not-undoable");
});

test("verbo e escopo da mudança", () => {
	assert.equal(memoryChangeVerb({ action: "add", undoOfId: null }), "Adicionou");
	assert.equal(memoryChangeVerb({ action: "replace", undoOfId: null }), "Alterou");
	assert.equal(memoryChangeVerb({ action: "remove", undoOfId: null }), "Apagou");
	// O desfazer é gravado como a mudança inversa, mas é nomeado pelo que foi desfeito.
	assert.equal(memoryChangeVerb({ action: "remove", undoOfId: "c1" }), "Desfeito · Adicionou");
	assert.equal(memoryChangeVerb({ action: "add", undoOfId: "c1" }), "Desfeito · Apagou");
	assert.equal(memoryChangeVerb({ action: "replace", undoOfId: "c1" }), "Desfeito · Alterou");
	assert.equal(memoryChangeScope({ target: "user" }), "Sobre você");
	assert.equal(memoryChangeScope({ target: "memory" }), "Deste bot");
});
