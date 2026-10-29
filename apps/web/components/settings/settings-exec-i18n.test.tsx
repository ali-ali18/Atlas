import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { JEV_FEATURES, LLM_TIMEOUT_PRESET_VALUES, type EffectiveAccountConfig } from "@workspace/shared";
import { createTranslator } from "@/lib/i18n/translator";
import { loadMessages } from "@/lib/i18n/messages";
import { renderIn } from "./settings-i18n-render";
import { MAX_OUTPUT_SPEC, MAX_STEPS_SPEC, MAX_WALL_SPEC, TOOL_RESULT_SPEC, contextMemoryOptions, jevFeatureOptions, jevFeatureSpecs, jevMcpOptions, numberOptions, switchInheritNote, timeoutOptions } from "./jev-execution-state";
import { ExecutionSettingsView } from "./sections/execution";
import { GroupsCoordinationRow, JevSettingsView } from "./sections/jev";

Object.assign(globalThis, { React });

const tr = async (locale: "en-US" | "es-ES") => createTranslator(locale, await loadMessages(locale));

const execEffective = {
	execution: {
		discipline: { value: true, source: "default" },
		contextEconomy: { value: true, source: "env" },
		reactionOnly: { value: true, source: "default" },
		contextMemory: { value: "standard", source: "default" },
		llmTimeouts: { value: LLM_TIMEOUT_PRESET_VALUES.default, source: "default" },
		maxOutputTokens: { value: undefined, source: "default" },
		maxSteps: { value: undefined, source: "default" },
		maxWallMinutes: { value: undefined, source: "default" },
		toolResultMaxChars: { value: undefined, source: "default" },
		maxRunCostUsd: { value: undefined, source: "default" },
	},
	sandboxAutoStart: { value: true, source: "default" },
} as unknown as EffectiveAccountConfig;

test("Execução em inglês: rótulos, notas de origem e opções de herança", async () => {
	const html = await renderIn("en-US", <ExecutionSettingsView effective={execEffective} onChange={() => {}} onSandboxChange={() => {}} status="idle" />);
	assert.match(html, /<h3[^>]*>Execution<\/h3>/);
	assert.match(html, /for="settings-exec-discipline"[^>]*>Execution discipline</);
	assert.match(html, /Server default: on/);
	assert.match(html, /Summarizes near the model&#x27;s limit/);
	assert.match(html, /Inherit \(300 steps\)/);
	assert.match(html, /Inherit \(30 min\)/);
	assert.match(html, /Inherit \(no limit\)/);
	assert.match(html, /Start the browser automatically/);
	assert.doesNotMatch(html, /Disciplina|Herdar|Carregando/);
});

test("Execução em espanhol: formatos de número e memória", async () => {
	const es = await tr("es-ES");
	assert.equal(numberOptions(TOOL_RESULT_SPEC, { value: undefined, source: "default" }, "", es)[0]?.label, "Heredar (20 mil caracteres)");
	assert.equal(numberOptions(MAX_OUTPUT_SPEC, { value: 8192, source: "user" }, "", es)[0]?.label, "Heredar del servidor");
	assert.equal(numberOptions(MAX_STEPS_SPEC, { value: undefined, source: "env" }, "", es)[0]?.label, "Heredar (300 pasos)");
	assert.equal(numberOptions(MAX_WALL_SPEC, { value: 120, source: "user" }, "", es).at(-1)?.label, "2 h");
	assert.equal(contextMemoryOptions(es)[1]?.label, "Económico");
	assert.equal(switchInheritNote({ value: false, source: "default" }, es), "Predeterminado de la cuenta: desactivado");
	assert.equal(timeoutOptions({ value: LLM_TIMEOUT_PRESET_VALUES.short, source: "env" }, es)[0]?.label, "Heredar (corto)");
});

const jevEffective = {
	models: { reviewer: { value: undefined, source: "default" }, maintenance: { value: undefined, source: "default" }, default: { value: undefined, source: "default" } },
	groups: { jevCoordination: { value: false, source: "default" } },
	jev: { mcp: { value: "gate", source: "env" }, features: Object.fromEntries(JEV_FEATURES.map((feature) => [feature, { value: "off", source: "default" }])) },
} as unknown as EffectiveAccountConfig;

test("Revisão automática em inglês", async () => {
	const html = await renderIn("en-US", <JevSettingsView config={{ v: 1 }} effective={jevEffective} onChange={() => {}} status="idle" />);
	assert.match(html, /<h3[^>]*>General reviews<\/h3>/);
	assert.match(html, /Review of connector writes/);
	assert.match(html, /Inherit \(Block\)/);
	assert.match(html, /Fine-tune by feature/);
	assert.match(html, /7 fine adjustments, one per feature/);
	assert.doesNotMatch(html, /Revisões|Herdar|ajustes finos/);
	const groups = await renderIn("en-US", <GroupsCoordinationRow account={{ view: { effective: jevEffective }, save: async () => {} } as never} />);
	assert.match(groups, /Groups: smart coordination/);
});

test("recursos do revisor e opções por idioma", async () => {
	const es = await tr("es-ES");
	assert.equal(jevFeatureSpecs(es).find((spec) => spec.feature === "memory")?.label, "Portero de la memoria");
	assert.equal(jevMcpOptions({ value: "gate", source: "default" }, es)[0]?.label, "Heredar (Bloquear)");
	assert.equal(jevFeatureOptions({ v: 1, jev: { all: "shadow" } }, { value: "off", source: "env" }, es)[0]?.label, "Heredar (general: Observar)");
});
