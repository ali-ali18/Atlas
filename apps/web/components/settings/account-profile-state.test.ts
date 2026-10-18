import assert from "node:assert/strict";
import test from "node:test";
import { nameDraftState } from "./account-profile-state";
import { centerSquare, checkPickedFile } from "../../lib/profile-image";

test("nome: só habilita salvar quando mudou e é válido (1 a 60, sem espaços nas pontas)", () => {
	assert.deepEqual(nameDraftState("Ana", "Ana"), { dirty: false, error: null, value: "Ana" });
	assert.deepEqual(nameDraftState("  Ana   Paula ", "Ana"), { dirty: true, error: null, value: "Ana Paula" });
	assert.equal(nameDraftState("", "Ana").error, "O nome não pode ficar vazio.");
	assert.equal(nameDraftState("   ", "Ana").value, null);
	assert.equal(nameDraftState("", "").error, null, "campo vazio de quem nunca salvou não reclama");
	assert.equal(nameDraftState("x".repeat(61), "Ana").value, null);
	assert.match(nameDraftState("x".repeat(61), "Ana").error ?? "", /60/);
	assert.equal(nameDraftState("x".repeat(60), "Ana").value, "x".repeat(60));
});

test("recorte quadrado central, em retrato e paisagem", () => {
	assert.deepEqual(centerSquare(1000, 600), { sx: 200, sy: 0, side: 600 });
	assert.deepEqual(centerSquare(600, 1000), { sx: 0, sy: 200, side: 600 });
	assert.deepEqual(centerSquare(300, 300), { sx: 0, sy: 0, side: 300 });
});

test("arquivo escolhido: só imagem raster e de tamanho razoável (SVG não)", () => {
	assert.equal(checkPickedFile({ type: "image/jpeg", size: 3_000_000 }).ok, true);
	assert.equal(checkPickedFile({ type: "image/heic", size: 3_000_000 }).ok, true);
	assert.equal(checkPickedFile({ type: "image/svg+xml", size: 100 }).ok, false);
	assert.equal(checkPickedFile({ type: "application/pdf", size: 100 }).ok, false);
	assert.equal(checkPickedFile({ type: "image/png", size: 40_000_000 }).ok, false);
});
