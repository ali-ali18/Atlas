import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS_JUDGE_MODEL_DEFAULT, actionsJevMode, actionsJudgeModel, PROACTIVE_FAILURE_MESSAGE, proactiveFailureDisplay, proactiveJevMode, resolveProactiveForRun } from "./proactive-run.js";

const policyOn = { proactive: { enabled: true, routineMode: "auto" } };

test("só o bot principal com o modo ligado, em chat próprio ou run proativo", () => {
	const base = { origin: "chat", isGroupRun: false, isPrimary: true, policyJson: policyOn };
	assert.equal(resolveProactiveForRun(base)?.settings.routineMode, "auto");
	assert.ok(resolveProactiveForRun({ ...base, origin: "proactive" }));
	assert.equal(resolveProactiveForRun({ ...base, isPrimary: false }), undefined);
	assert.equal(resolveProactiveForRun({ ...base, isGroupRun: true }), undefined);
	assert.equal(resolveProactiveForRun({ ...base, policyJson: { proactive: { enabled: false } } }), undefined);
	assert.equal(resolveProactiveForRun({ ...base, policyJson: null }), undefined);
});

test("rotina, webhook, bot e subagente nunca recebem o modo proativo", () => {
	for (const origin of ["routine", "webhook", "bot", "subagent"]) {
		assert.equal(resolveProactiveForRun({ origin, isGroupRun: false, isPrimary: true, policyJson: policyOn }), undefined);
	}
});

test("padrão do Sugerir quando a política só liga o modo", () => {
	const resolved = resolveProactiveForRun({ origin: "chat", isGroupRun: false, isPrimary: true, policyJson: { proactive: { enabled: true } } });
	assert.equal(resolved?.settings.routineMode, "suggest");
	assert.equal(resolved?.settings.maxPerDay, 3);
});

test("fuso das configurações da conta vale no run; sem ele, o do bot", () => {
	const base = { origin: "chat", isGroupRun: false, isPrimary: true, policyJson: { proactive: { enabled: true, timezone: "America/Sao_Paulo" } } };
	assert.equal(resolveProactiveForRun(base)?.settings.timezone, "America/Sao_Paulo");
	assert.equal(resolveProactiveForRun({ ...base, accountTimezone: "Europe/Lisbon" })?.settings.timezone, "Europe/Lisbon");
	assert.equal(resolveProactiveForRun({ ...base, accountTimezone: null })?.settings.timezone, "America/Sao_Paulo");
});

test("Jev da mensagem proativa: env manda; sem env segue a intenção; sem nada, desligado", () => {
	assert.equal(proactiveJevMode("on", {}), "on");
	assert.equal(proactiveJevMode("shadow", {}), "shadow");
	assert.equal(proactiveJevMode(undefined, {}), "off");
	assert.equal(proactiveJevMode("on", { JEV_PROACTIVE_MODE: "off" }), "off");
	assert.equal(proactiveJevMode("off", { JEV_PROACTIVE_MODE: "shadow" }), "shadow");
	assert.equal(proactiveJevMode("on", { JEV_PROACTIVE_MODE: "lixo" }), "on");
});

test("falha de run proativo mostra mensagem amigável, nunca o erro técnico", () => {
	const raw = "429 Rate limit exceeded at provider - at fetch (stack)";
	assert.equal(proactiveFailureDisplay("proactive", raw), PROACTIVE_FAILURE_MESSAGE);
	assert.ok(!PROACTIVE_FAILURE_MESSAGE.includes("429"));
	assert.equal(proactiveFailureDisplay("chat", raw), raw);
	assert.match(proactiveFailureDisplay("proactive", raw, "en-US"), /scheduled reminder/);
	assert.match(proactiveFailureDisplay("proactive", raw, "es-ES"), /recordatorio programado/);
});

test("Verificador de ações: ligado por padrão, JEV_ACTIONS_MODE manda e o modelo é trocável", () => {
	assert.equal(actionsJevMode({}), "on");
	assert.equal(actionsJevMode({ JEV_ACTIONS_MODE: "off" }), "off");
	assert.equal(actionsJevMode({ JEV_ACTIONS_MODE: "shadow" }), "shadow");
	assert.equal(actionsJevMode({ JEV_ACTIONS_MODE: "lixo" }), "on");
	assert.equal(actionsJudgeModel({}), ACTIONS_JUDGE_MODEL_DEFAULT);
	assert.equal(actionsJudgeModel({ JEV_ACTIONS_MODEL: " vendor/rapido " }), "vendor/rapido");
});
