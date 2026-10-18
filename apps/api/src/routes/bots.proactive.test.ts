import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ??= "test-pepper-for-proactive-route";
process.env.ATLAS_OWNER_EMAIL ??= "test@example.com";
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-proactive-route";
const { checkProactivePolicy } = await import("./bots.js");

const ok = { enabled: true, routineMode: "suggest", maxPerDay: 3, quietStart: "22:00", quietEnd: "08:00", timezone: "America/Sao_Paulo" };

test("sem a chave proactive (ou política vazia) não há o que validar", () => {
	assert.equal(checkProactivePolicy(null, false), null);
	assert.equal(checkProactivePolicy({ subagentModel: "x/y" }, false), null);
	assert.equal(checkProactivePolicy({ proactive: null }, false), null);
});

test("configuração completa e válida passa no bot principal", () => {
	assert.equal(checkProactivePolicy({ proactive: ok }, true), null);
	assert.equal(checkProactivePolicy({ proactive: { ...ok, routineMode: "auto", maxPerDay: 10 } }, true), null);
});

test("ligar o modo num bot que não é o principal é recusado com a dica da UI", () => {
	assert.equal(checkProactivePolicy({ proactive: ok }, false), "Disponível no bot principal");
});

test("desligar (ou só guardar ajustes) num bot não principal é permitido", () => {
	assert.equal(checkProactivePolicy({ proactive: { ...ok, enabled: false } }, false), null);
});

test("valores inválidos são recusados", () => {
	const bad = (patch: Record<string, unknown>) => checkProactivePolicy({ proactive: { ...ok, ...patch } }, true);
	assert.match(bad({ enabled: "sim" }) ?? "", /enabled/);
	assert.match(bad({ routineMode: "tanto faz" }) ?? "", /Sugerir ou Automático/);
	assert.match(bad({ maxPerDay: 0 }) ?? "", /máximo por dia/);
	assert.match(bad({ maxPerDay: 11 }) ?? "", /máximo por dia/);
	assert.match(bad({ maxPerDay: 2.5 }) ?? "", /máximo por dia/);
	assert.match(bad({ quietStart: "25:00" }) ?? "", /silêncio/);
	assert.match(bad({ quietEnd: "oito" }) ?? "", /silêncio/);
	assert.match(bad({ timezone: "Marte/Olympus" }) ?? "", /fuso/);
	assert.match(checkProactivePolicy({ proactive: "on" }, true) ?? "", /inválida/);
	assert.match(checkProactivePolicy({ proactive: [] }, true) ?? "", /inválida/);
});
