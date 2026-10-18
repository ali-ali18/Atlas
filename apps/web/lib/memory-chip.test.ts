import assert from "node:assert/strict";
import test from "node:test";
import { isMemoryUpdateResult, memoryChipId } from "./memory-chip";

test("só a gravação bem-sucedida da tool memory mostra o chip", () => {
	assert.equal(isMemoryUpdateResult({ name: "memory", ok: true, summary: "Memória atualizada (add em memory)." }), true);
	assert.equal(isMemoryUpdateResult({ name: "memory", ok: true, summary: "Falha ao atualizar memória: duplicado. Uso: 1/2" }), false);
	assert.equal(isMemoryUpdateResult({ name: "memory", ok: false, summary: "Memória atualizada" }), false);
	assert.equal(isMemoryUpdateResult({ name: "memory_search", ok: true, summary: "Memória atualizada" }), false);
});

test("id do chip é um por run", () => {
	assert.equal(memoryChipId("run-1"), "memory-updated-run-1");
	assert.equal(memoryChipId(undefined), "memory-updated-local");
});
