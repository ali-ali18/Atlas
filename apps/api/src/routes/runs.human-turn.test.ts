import assert from "node:assert/strict";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { isHumanTypedTurn } = await import("./runs.js");

test("turno humano: só chat digitado (não silencioso, sem cartão de confirmação nem compactação)", () => {
	assert.equal(isHumanTypedTurn({ origin: "chat" }, false), true);
	assert.equal(isHumanTypedTurn({}, false), false, "origin ausente no request já resolvido não conta");
	assert.equal(isHumanTypedTurn({ origin: "chat", silent: true }, false), false);
	assert.equal(isHumanTypedTurn({ origin: "chat", compact: true }, false), false);
	assert.equal(isHumanTypedTurn({ origin: "chat", decisionConfirmId: "c1" }, false), false);
	assert.equal(isHumanTypedTurn({ origin: "chat" }, true), false, "continuação de ação confirmada é texto do sistema");
	for (const origin of ["routine", "webhook"] as const) assert.equal(isHumanTypedTurn({ origin }, false), false);
});
