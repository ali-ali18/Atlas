import assert from "node:assert/strict";
import test from "node:test";
import {
	JEV_FEATURES,
	LLM_TIMEOUT_PRESETS,
	LLM_TIMEOUT_PRESET_VALUES,
	MAX_OUTPUT_TOKEN_PRESETS,
	validateAccountConfigPatch,
	type AccountConfigV1,
} from "@workspace/shared";
import {
	INHERIT,
	JEV_FEATURE_SPECS,
	MAX_OUTPUT_SPEC,
	MAX_STEPS_SPEC,
	MAX_WALL_SPEC,
	disciplinePatch,
	jevFeatureChoice,
	jevFeatureOptions,
	jevFeaturePatch,
	jevGeneralChoice,
	jevGeneralPatch,
	jevMcpChoice,
	jevMcpOptions,
	jevMcpPatch,
	numberChoice,
	numberOptions,
	numberPatch,
	switchInheritNote,
	timeoutChoice,
	timeoutOptions,
	timeoutPatch,
	timeoutPresetOf,
} from "./jev-execution-state";

const labelOf = (options: { value: string; label: string }[], value: string) =>
	options.find((option) => option.value === value)?.label;

test("Jev: 7 recursos, um por chave do contrato, sem repetir", () => {
	assert.deepEqual(JEV_FEATURE_SPECS.map((spec) => spec.feature).sort(), [...JEV_FEATURES].sort());
	assert.equal(new Set(JEV_FEATURE_SPECS.map((spec) => spec.itemId)).size, 7);
	for (const spec of JEV_FEATURE_SPECS) assert.ok(spec.description.length < 80, "uma linha");
});

test("Jev: modos mapeiam para o contrato e herdar vira null", () => {
	assert.deepEqual(jevMcpPatch("gate"), { jev: { mcp: "gate" } });
	assert.deepEqual(jevMcpPatch(INHERIT), { jev: { mcp: null } });
	assert.deepEqual(jevGeneralPatch("shadow"), { jev: { all: "shadow" } });
	assert.deepEqual(jevGeneralPatch(INHERIT), { jev: { all: null } });
	assert.deepEqual(jevFeaturePatch("stuck", "on"), { jev: { features: { stuck: "on" } } });
	assert.deepEqual(jevFeaturePatch("verify", INHERIT), { jev: { features: { verify: null } } });
	for (const patch of [jevMcpPatch("gate"), jevGeneralPatch("on"), jevFeaturePatch("intent", "shadow")]) {
		assert.equal(validateAccountConfigPatch(patch).ok, true);
	}
});

test("Jev: rótulos Desligado/Observar/Ativo e Desligado/Observar/Bloquear", () => {
	const mcp = jevMcpOptions({ value: "off", source: "default" });
	assert.deepEqual(mcp.slice(1).map((o) => o.label), ["Desligado", "Observar", "Bloquear"]);
	assert.equal(mcp[0]?.label, "Herdar (Desligado)");
	const feature = jevFeatureOptions({ v: 1 }, { value: "off", source: "env" });
	assert.deepEqual(feature.slice(1).map((o) => o.label), ["Desligado", "Observar", "Ativo"]);
	assert.equal(feature[0]?.label, "Herdar (Desligado)");
});

test("Jev: recurso herda do geral da conta quando ele está definido", () => {
	const config: AccountConfigV1 = { v: 1, jev: { all: "shadow", features: { intent: "on" } } };
	const resolved = { value: "shadow", source: "user" } as const;
	assert.equal(labelOf(jevFeatureOptions(config, resolved), INHERIT), "Herdar (geral: Observar)");
	assert.equal(jevFeatureChoice(config, "intent"), "on");
	assert.equal(jevFeatureChoice(config, "tools"), INHERIT, "valor vindo do geral não é escolha própria");
	assert.equal(jevGeneralChoice(config), "shadow");
	assert.equal(jevGeneralChoice({ v: 1 }), INHERIT);
	assert.equal(jevMcpChoice({ value: "gate", source: "user" }), "gate");
	assert.equal(jevMcpChoice({ value: "gate", source: "env" }), INHERIT);
});

test("Execução: presets de paciência mapeiam para o contrato e reconhecem os prazos herdados", () => {
	for (const preset of LLM_TIMEOUT_PRESETS) {
		assert.deepEqual(timeoutPatch(preset), { execution: { llmTimeoutPreset: preset } });
		assert.equal(timeoutPresetOf(LLM_TIMEOUT_PRESET_VALUES[preset]), preset);
	}
	assert.deepEqual(timeoutPatch(INHERIT), { execution: { llmTimeoutPreset: null } });
	assert.equal(timeoutPresetOf({ totalMs: 1, firstEventMs: 1, idleMs: 1 }), null);
	const inherited = timeoutOptions({ value: LLM_TIMEOUT_PRESET_VALUES.short, source: "env" });
	assert.equal(inherited[0]?.label, "Herdar (curto)");
	assert.deepEqual(inherited.slice(1).map((o) => o.label), ["Curto", "Padrão", "Estendido"]);
	assert.equal(timeoutChoice({ value: LLM_TIMEOUT_PRESET_VALUES.extended, source: "user" }), "extended");
	assert.equal(timeoutChoice({ value: LLM_TIMEOUT_PRESET_VALUES.extended, source: "env" }), INHERIT);
});

test("Execução: todo preset numérico passa na validação estrita do contrato", () => {
	const specs = [
		["maxOutputTokens", MAX_OUTPUT_SPEC],
		["maxSteps", MAX_STEPS_SPEC],
		["maxWallMinutes", MAX_WALL_SPEC],
	] as const;
	for (const [key, spec] of specs) {
		for (const preset of spec.presets) {
			const patch = numberPatch(key, String(preset));
			assert.deepEqual(patch, { execution: { [key]: preset } });
			assert.equal(validateAccountConfigPatch(patch).ok, true, `${key}=${preset}`);
		}
		assert.deepEqual(numberPatch(key, INHERIT), { execution: { [key]: null } });
	}
	assert.deepEqual([...MAX_OUTPUT_SPEC.presets], [...MAX_OUTPUT_TOKEN_PRESETS]);
	for (const on of [true, false]) assert.equal(validateAccountConfigPatch(disciplinePatch(on)).ok, true);
});

test("Execução: tamanho da resposta, passos e tempo mostram o valor herdado", () => {
	const out = numberOptions(MAX_OUTPUT_SPEC, { value: undefined, source: "default" }, "sem limite");
	assert.equal(out[0]?.label, "Herdar (sem limite)");
	assert.deepEqual(out.slice(1).map((o) => o.label), ["2k tokens", "4k tokens", "8k tokens", "16k tokens", "32k tokens"]);
	const fromEnv = numberOptions(MAX_OUTPUT_SPEC, { value: 8192, source: "env" }, "sem limite");
	assert.equal(fromEnv[0]?.label, "Herdar (8k tokens)");
	assert.equal(numberOptions(MAX_STEPS_SPEC, { value: undefined, source: "default" }, "")[0]?.label, "Herdar (300 passos)");
	assert.equal(numberOptions(MAX_WALL_SPEC, { value: undefined, source: "default" }, "")[0]?.label, "Herdar (30 min)");
	assert.deepEqual(
		numberOptions(MAX_WALL_SPEC, { value: undefined, source: "default" }, "")
			.slice(1)
			.map((o) => o.label),
		["5 min", "10 min", "15 min", "30 min", "1 h", "2 h"],
	);
});

test("Execução: valor do usuário fora dos presets continua visível e escolhido", () => {
	const resolved = { value: 40, source: "user" } as const;
	const options = numberOptions(MAX_STEPS_SPEC, resolved, "");
	assert.equal(options[0]?.label, "Herdar do servidor");
	assert.ok(options.some((o) => o.value === "40" && o.label === "40 passos"));
	assert.equal(numberChoice(resolved), "40");
	assert.equal(numberChoice({ value: 25, source: "env" }), INHERIT);
	assert.equal(numberChoice({ value: undefined, source: "default" }), INHERIT);
});

test("switch herdado diz de onde vem; o do usuário não mostra nota", () => {
	assert.equal(switchInheritNote({ value: true, source: "default" }), "Padrão da conta: ligado");
	assert.equal(switchInheritNote({ value: false, source: "env" }), "Padrão do servidor: desligado");
	assert.equal(switchInheritNote({ value: false, source: "user" }), null);
});
