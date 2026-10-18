import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVAL_BAR_RESERVE_PX, distanceFromBottom, needsBottomCorrection, transcriptBottomPadding } from "./scroll-bottom";

test("sem pedido pendente não mexe no padding", () => {
	assert.equal(transcriptBottomPadding(false, 80), undefined);
});

test("com pedido pendente a reserva é constante, com a barra visível ou não", () => {
	assert.equal(transcriptBottomPadding(true, 0), `calc(11rem + ${APPROVAL_BAR_RESERVE_PX}px)`);
	assert.equal(transcriptBottomPadding(true, 60), transcriptBottomPadding(true, 0));
	assert.equal(transcriptBottomPadding(true, 140.2), "calc(11rem + 141px)");
});

test("correção de fim de rolagem", () => {
	assert.equal(distanceFromBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 }), 100);
	assert.equal(needsBottomCorrection({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 }), true);
	assert.equal(needsBottomCorrection({ scrollHeight: 1000, scrollTop: 499, clientHeight: 500 }), false);
});
