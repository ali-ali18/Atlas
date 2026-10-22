import assert from "node:assert/strict";
import test from "node:test";
import { planImageRow } from "./image-row-plan";

const s = (width: number, height: number) => ({ width, height });

test("todas cabem: mostra todas na mesma altura, sem dobra", () => {
	const plan = planImageRow({ sizes: [s(400, 300), s(300, 300)], availableWidth: 700 });
	assert.equal(plan.foldedCount, 0);
	assert.equal(plan.height, 192);
	assert.deepEqual(plan.tiles.map((t) => t.width), [256, 192]);
	assert.ok(plan.tiles.every((t) => t.height === 192));
});

test("altura natural menor limita a fileira (teto por imagem)", () => {
	const plan = planImageRow({ sizes: [s(200, 100), s(800, 600)], availableWidth: 700 });
	assert.equal(plan.height, 100);
});

test("não cabem: dobra para 3 tiles com +N na última", () => {
	const plan = planImageRow({ sizes: Array.from({ length: 6 }, () => s(400, 300)), availableWidth: 368 });
	assert.equal(plan.tiles.length, 3);
	assert.equal(plan.foldedCount, 4);
	const used = plan.tiles.reduce((sum, t) => sum + t.width, 0) + 6 * 2;
	assert.ok(used <= 368);
	assert.ok(plan.height >= 64 && plan.height <= 192);
});

test("exatamente 3 imagens que não cabem encolhem sem dobrar", () => {
	const plan = planImageRow({ sizes: [s(400, 300), s(400, 300), s(400, 300)], availableWidth: 420 });
	assert.equal(plan.tiles.length, 3);
	assert.equal(plan.foldedCount, 0);
});

test("fecha em 2 tiles quando 3 passam do mínimo de 64", () => {
	const plan = planImageRow({ sizes: Array.from({ length: 5 }, () => s(400, 300)), availableWidth: 250 });
	assert.equal(plan.tiles.length, 2);
	assert.equal(plan.foldedCount, 4);
});

test("dobra para 1 tile quando nem 2 cabem, com +n", () => {
	const plan = planImageRow({ sizes: [s(400, 300), s(400, 300), s(400, 300)], availableWidth: 120 });
	assert.equal(plan.tiles.length, 1);
	assert.equal(plan.foldedCount, 3);
	assert.ok(plan.tiles[0]!.width <= 120);
});

test("imagem única: 1 tile, sem +n; largura limitada ao espaço disponível", () => {
	const plan = planImageRow({ sizes: [s(1600, 400)], availableWidth: 300 });
	assert.equal(plan.foldedCount, 0);
	assert.equal(plan.tiles[0]!.width, 300);
	const tall = planImageRow({ sizes: [s(300, 900)], availableWidth: 368 });
	assert.equal(tall.height, 192);
	assert.equal(tall.tiles[0]!.width, 64);
});

test("tamanho desconhecido usa 4/3", () => {
	const plan = planImageRow({ sizes: [undefined, { width: 0, height: 0 }], availableWidth: 700 });
	assert.deepEqual(plan.tiles.map((t) => t.width), [256, 256]);
	assert.equal(planImageRow({ sizes: [], availableWidth: 300 }).tiles.length, 0);
});
