import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { memoryRef, stripMemoryRefPrefix } from "./memory-entries.js";

describe("ref curta da memória", () => {
	test("final do id só com dígitos: a ref cresce até ter uma letra e é removida do começo do conteúdo", () => {
		// Reproduz a falha intermitente do memory-refs.db.test: cuid terminado em 4 dígitos virava
		// `[1234]`, que o strip trata como texto do usuário (ano) e não remove.
		const id = "cmh0abcdefghij0k9x81234";
		const ref = memoryRef(id);
		assert.equal(ref, "x81234");
		assert.ok(id.endsWith(ref));
		assert.equal(stripMemoryRefPrefix(`[${ref}]Cidade: Curitiba/PR`), "Cidade: Curitiba/PR");
		assert.equal(stripMemoryRefPrefix(`- [${ref}] Cidade`), "Cidade");
	});

	test("ref normal continua com 4 caracteres e texto do usuário entre colchetes fica", () => {
		assert.equal(memoryRef("cmh0abcdefghijklmna2dl"), "a2dl");
		assert.equal(stripMemoryRefPrefix("[2024] Plano anual"), "[2024] Plano anual");
		assert.equal(stripMemoryRefPrefix("[urgente] pagar conta"), "[urgente] pagar conta");
		assert.equal(stripMemoryRefPrefix("[nota longa] x"), "[nota longa] x");
		assert.equal(memoryRef("12345678901"), "12345678901");
	});
});
