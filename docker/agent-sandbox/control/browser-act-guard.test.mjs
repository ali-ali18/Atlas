import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeAct } from "./browser-act-guard.mjs";

const probe = (over = {}) => ({ tag: "button", secret: "", writeForm: false, submitControl: false, field: false, captcha: false, ...over });

test("senha e código: nunca digitados, qualquer intent", () => {
	for (const secret of ["password", "code"]) for (const intent of ["browse", "submit"]) {
		const v = judgeAct(probe({ tag: "input", field: true, secret }), { action: "type", text: "x", intent });
		assert.deepEqual(v, { verdict: "needs_owner", needsOwner: secret });
	}
});

test("captcha é do dono", () => {
	assert.deepEqual(judgeAct(probe({ captcha: true }), { action: "click", intent: "browse" }), { verdict: "needs_owner", needsOwner: "captcha" });
});

test("botão que envia formulário que escreve exige intent submit", () => {
	const send = probe({ submitControl: true, writeForm: true });
	assert.equal(judgeAct(send, { action: "click", intent: "browse" }).verdict, "needs_submit_intent");
	assert.equal(judgeAct(send, { action: "click", intent: "submit" }).verdict, "ok");
});

test("busca (form GET) e botão comum são navegação livre", () => {
	assert.equal(judgeAct(probe({ submitControl: true, writeForm: false }), { action: "click", intent: "browse" }).verdict, "ok");
	assert.equal(judgeAct(probe(), { action: "click", intent: "browse" }).verdict, "ok");
});

test("Enter num campo de formulário que escreve envia", () => {
	const field = probe({ tag: "input", field: true, writeForm: true });
	assert.equal(judgeAct(field, { action: "press", text: "Enter", intent: "browse" }).verdict, "needs_submit_intent");
	assert.equal(judgeAct(field, { action: "press", text: "Tab", intent: "browse" }).verdict, "ok");
	assert.equal(judgeAct(field, { action: "type", text: "oi", intent: "browse" }).verdict, "ok");
});
