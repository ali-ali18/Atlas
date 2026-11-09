import { test } from "node:test";
import assert from "node:assert/strict";
import { isEnterKey, judgeAct, probeActTarget } from "./browser-act-guard.mjs";

const probe = (over = {}) => ({ tag: "button", secret: "", inForm: false, writeForm: false, submitControl: false, field: false, captcha: false, ...over });

test("senha e código: nunca digitados, qualquer intent", () => {
	for (const secret of ["password", "code"]) for (const intent of ["browse", "submit"]) {
		const v = judgeAct(probe({ tag: "input", field: true, secret }), { action: "type", text: "x", intent });
		assert.deepEqual(v, { verdict: "needs_owner", needsOwner: secret });
	}
});

test("captcha é do dono", () => {
	assert.deepEqual(judgeAct(probe({ captcha: true }), { action: "click", intent: "browse" }), { verdict: "needs_owner", needsOwner: "captcha" });
});

test("botão que envia formulário exige intent submit, com ou sem action (form de SPA)", () => {
	for (const writeForm of [true, false]) {
		const send = probe({ submitControl: true, inForm: true, writeForm });
		assert.equal(judgeAct(send, { action: "click", intent: "browse" }).verdict, "needs_submit_intent", `writeForm=${writeForm}`);
		assert.equal(judgeAct(send, { action: "click", intent: "submit" }).verdict, "ok");
	}
});

test("botão de JavaScript fora de formulário não tem sinal estrutural: vale o intent declarado", () => {
	assert.equal(judgeAct(probe({ inForm: false, submitControl: false }), { action: "click", intent: "browse" }).verdict, "ok");
});

test("Enter em qualquer variante num campo dentro de form envia; fora de form ou outra tecla não", () => {
	const field = probe({ tag: "input", field: true, inForm: true });
	for (const key of ["Enter", "enter", "NumpadEnter", "Return", "Control+Enter", "Shift+Enter", "Meta+Alt+Enter"]) {
		assert.equal(judgeAct(field, { action: "press", text: key, intent: "browse" }).verdict, "needs_submit_intent", key);
		assert.equal(judgeAct(field, { action: "press", text: key, intent: "submit" }).verdict, "ok");
	}
	assert.equal(judgeAct(field, { action: "press", text: "Tab", intent: "browse" }).verdict, "ok");
	assert.equal(judgeAct(field, { action: "press", text: "Control+a", intent: "browse" }).verdict, "ok");
	assert.equal(judgeAct(probe({ tag: "input", field: true, inForm: false }), { action: "press", text: "Enter", intent: "browse" }).verdict, "ok");
	assert.equal(judgeAct(field, { action: "type", text: "oi", intent: "browse" }).verdict, "ok");
	assert.equal(isEnterKey("Control+Enter"), true);
	assert.equal(isEnterKey("Shift++"), false);
});

test("textarea: Enter puro é quebra de linha; com modificador envia", () => {
	const area = probe({ tag: "textarea", field: true, inForm: true });
	assert.equal(judgeAct(area, { action: "press", text: "Enter", intent: "browse" }).verdict, "ok");
	assert.equal(judgeAct(area, { action: "press", text: "Control+Enter", intent: "browse" }).verdict, "needs_submit_intent");
});

test("sonda estrutural (elemento falso): button sem type, input submit/image, formaction e type=button", () => {
	const el = (tag, attrs = {}, type, form = { getAttribute: () => null }) => ({
		tagName: tag.toUpperCase(),
		type: type ?? (tag === "button" ? "submit" : ""),
		form,
		id: "",
		getAttribute: (n) => attrs[n] ?? null,
		hasAttribute: (n) => n in attrs,
		closest: () => null,
		matches: () => false,
	});
	assert.equal(probeActTarget(el("button")).submitControl, true, "button sem type");
	assert.equal(probeActTarget(el("button", { type: "submit" })).submitControl, true);
	assert.equal(probeActTarget(el("input", { type: "submit" }, "submit")).submitControl, true);
	assert.equal(probeActTarget(el("input", { type: "image" }, "image")).submitControl, true);
	assert.equal(probeActTarget(el("button", { type: "button" }, "button")).submitControl, false);
	assert.equal(probeActTarget(el("button", { type: "button", formaction: "/x" }, "button")).submitControl, true, "formaction");
	assert.equal(probeActTarget(el("button", { type: "button", formmethod: "post" }, "button")).submitControl, true, "formmethod");
	assert.equal(probeActTarget({ ...el("button"), form: null }).submitControl, false, "fora de form");
});
