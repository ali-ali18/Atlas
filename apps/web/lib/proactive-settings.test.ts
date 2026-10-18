import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROACTIVE_SETTINGS } from "@workspace/shared";
import {
	MAX_PER_DAY_OPTIONS,
	ROUTINE_MODE_OPTIONS,
	applyProactiveChange,
	proactiveAvailable,
	readProactiveSettings,
} from "./proactive-settings";

test("padrões: desligado, Sugerir, 3 por dia, silêncio 22:00-08:00", () => {
	assert.deepEqual(readProactiveSettings(undefined), DEFAULT_PROACTIVE_SETTINGS);
	assert.equal(DEFAULT_PROACTIVE_SETTINGS.enabled, false);
	assert.equal(DEFAULT_PROACTIVE_SETTINGS.routineMode, "suggest");
	assert.deepEqual(ROUTINE_MODE_OPTIONS.map((option) => option.label), ["Sugerir", "Automático"]);
	assert.equal(MAX_PER_DAY_OPTIONS.length, 10);
	assert.equal(MAX_PER_DAY_OPTIONS[0]?.value, "1");
});

test("só o bot principal pode usar o modo", () => {
	assert.equal(proactiveAvailable({ isPrimary: true }), true);
	assert.equal(proactiveAvailable({ isPrimary: false }), false);
	assert.equal(proactiveAvailable({}), false);
});

test("ligar grava enabled e sincroniza o fuso do navegador; desligar mantém o resto", () => {
	const on = applyProactiveChange(null, { type: "enabled", value: true }, "America/Recife");
	assert.deepEqual(readProactiveSettings(on), { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone: "America/Recife" });
	const off = applyProactiveChange(on, { type: "enabled", value: false }, "Europe/Lisbon");
	assert.equal(readProactiveSettings(off).enabled, false);
	assert.equal(readProactiveSettings(off).timezone, "America/Recife");
});

test("fuso inválido do navegador não vira configuração", () => {
	// `undefined` cairia no fuso real da máquina (UTC no CI); o caso é um fuso inválido vindo do navegador.
	const on = applyProactiveChange(null, { type: "enabled", value: true }, "Nao/Existe");
	assert.equal(readProactiveSettings(on).timezone, DEFAULT_PROACTIVE_SETTINGS.timezone);
});

test("modo de rotinas, limite diário e silêncio persistem sem perder o resto da política", () => {
	let policy: unknown = { subagentModel: "x/y", chatgptFallbackModel: null };
	policy = applyProactiveChange(policy, { type: "enabled", value: true }, "America/Sao_Paulo");
	policy = applyProactiveChange(policy, { type: "routineMode", value: "auto" });
	policy = applyProactiveChange(policy, { type: "maxPerDay", value: 5 });
	policy = applyProactiveChange(policy, { type: "quiet", start: "23:30" });
	policy = applyProactiveChange(policy, { type: "quiet", end: "07:00" });
	assert.deepEqual(readProactiveSettings(policy), {
		enabled: true,
		routineMode: "auto",
		maxPerDay: 5,
		quietStart: "23:30",
		quietEnd: "07:00",
		timezone: "America/Sao_Paulo",
	});
	assert.equal((policy as { subagentModel: string }).subagentModel, "x/y");
});

test("horário vazio ou inválido enquanto digita é ignorado", () => {
	const base = applyProactiveChange(null, { type: "enabled", value: true }, "America/Sao_Paulo");
	for (const bad of ["", "25:00", "abc"]) {
		assert.equal(readProactiveSettings(applyProactiveChange(base, { type: "quiet", start: bad })).quietStart, "22:00");
	}
});
