import assert from "node:assert/strict";
import test from "node:test";
import { isLongPress, LONG_PRESS_MOVE_TOLERANCE, LONG_PRESS_MS, pressMoved } from "./use-long-press";

test("pressão longa só a partir de 450 ms", () => {
	assert.equal(LONG_PRESS_MS, 450);
	assert.equal(isLongPress(1000, 1449), false);
	assert.equal(isLongPress(1000, 1450), true);
	assert.equal(isLongPress(1000, 1000, 200), false);
	assert.equal(isLongPress(1000, 1200, 200), true);
});

test("dedo que anda além da tolerância cancela (vira rolagem)", () => {
	const origin = { x: 100, y: 100 };
	assert.equal(pressMoved(origin, { x: 100, y: 100 }), false);
	assert.equal(pressMoved(origin, { x: 100 + LONG_PRESS_MOVE_TOLERANCE, y: 100 }), false);
	assert.equal(pressMoved(origin, { x: 100, y: 100 + LONG_PRESS_MOVE_TOLERANCE + 1 }), true);
	assert.equal(pressMoved(origin, { x: 107, y: 107 }), false);
	assert.equal(pressMoved(origin, { x: 108, y: 108 }), true);
});
