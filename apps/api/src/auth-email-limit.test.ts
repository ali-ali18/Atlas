import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmailCodeLimiter } from "./auth-email-limit.js";

test("permite 5 em 15 min e recusa o 6º; a janela desliza", () => {
	let now = 0;
	const limiter = createEmailCodeLimiter({ now: () => now });
	for (let i = 0; i < 5; i++) assert.equal(limiter.allow("dono@x.test"), true);
	assert.equal(limiter.allow("dono@x.test"), false);
	assert.equal(limiter.allow(" DONO@x.test "), false);
	now = 15 * 60_000 - 1;
	assert.equal(limiter.allow("dono@x.test"), false);
	now = 15 * 60_000;
	assert.equal(limiter.allow("dono@x.test"), true);
});

test("a conta é por e-mail", () => {
	const limiter = createEmailCodeLimiter({ max: 1 });
	assert.equal(limiter.allow("a@x.test"), true);
	assert.equal(limiter.allow("a@x.test"), false);
	assert.equal(limiter.allow("b@x.test"), true);
});
