import assert from "node:assert/strict";
import test from "node:test";
import { isJevToolReview, jevStatusText, type JevToolReview } from "./jev-status";

test("ignora dados de revisão inesperados no evento", () => {
	assert.equal(isJevToolReview({ mode: "gate", result: "allow" }), true);
	assert.equal(isJevToolReview({ mode: "gate", result: "approved", args: "secret" }), false);
	assert.equal(isJevToolReview(null), false);
});

test("só chama de aprovação a execução bem-sucedida em gate", () => {
	const cases: Array<[JevToolReview, boolean]> = [
		[{ mode: "gate", result: "allow" }, false],
		[{ mode: "gate", result: "ask" }, true],
		[{ mode: "gate", result: "unavailable" }, true],
		[{ mode: "shadow", result: "allow" }, true],
		[{ mode: "shadow", result: "ask" }, true],
		[{ mode: "shadow", result: "unavailable" }, true],
	];
	assert.equal(jevStatusText({ mode: "gate", result: "allow" }, true), "JEV aprovou esta ação.");
	for (const [review, ok] of cases) {
		assert.doesNotMatch(jevStatusText(review, ok), /JEV aprovou esta ação/);
	}
});

test("distingue confirmação pendente, observação e falha da ferramenta", () => {
	assert.match(jevStatusText({ mode: "gate", result: "ask" }, true), /ainda não foi executada/);
	assert.match(jevStatusText({ mode: "gate", result: "unavailable" }, true), /aguarda confirmação/);
	assert.match(jevStatusText({ mode: "shadow", result: "ask" }, true), /modo de observação; a ação foi executada/);
	assert.match(jevStatusText({ mode: "shadow", result: "allow" }, false), /ferramenta falhou/);
});
