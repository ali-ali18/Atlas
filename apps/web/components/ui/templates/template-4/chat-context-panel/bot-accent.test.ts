import assert from "node:assert/strict";
import test from "node:test";
import { botAccent, relativeLuminance } from "./bot-accent";

function lum(hex: string) {
	const n = Number.parseInt(hex.slice(1), 16);
	return relativeLuminance([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
}

test("cor escura é mantida", () => {
	assert.equal(botAccent("#6366f1")?.accent, "#6366f1");
});

test("cor muito clara é escurecida até o knob branco ter contraste >= 3:1", () => {
	const result = botAccent("#ffff00");
	assert.ok(result);
	assert.ok(lum(result.accent) <= 0.3);
	assert.ok(1.05 / (lum(result.accent) + 0.05) >= 3);
});

test("aceita #rgb e rejeita valores inválidos", () => {
	assert.equal(botAccent("#000")?.accent, "#000000");
	assert.equal(botAccent("red"), null);
	assert.equal(botAccent(undefined), null);
});
