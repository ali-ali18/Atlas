import assert from "node:assert/strict";
import test from "node:test";
import { fitImageSize } from "./image-viewer-size";

test("captura larga cabe no desktop preservando proporção", () => {
	assert.deepEqual(fitImageSize(1600, 900, 1000, 600), { width: 1000, height: 562.5 });
});

test("imagem alta cabe no celular sem cortar partes", () => {
	assert.deepEqual(fitImageSize(600, 1200, 358, 600), { width: 300, height: 600 });
});

test("não amplia miniaturas antes do zoom", () => {
	assert.deepEqual(fitImageSize(112, 112, 1000, 700), { width: 112, height: 112 });
});

test("aguarda uma área válida e evita dimensões não finitas", () => {
	for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.deepEqual(fitImageSize(800, 600, value, 700), { width: 0, height: 0 });
		assert.deepEqual(fitImageSize(value, 600, 800, 700), { width: 0, height: 0 });
	}
});
