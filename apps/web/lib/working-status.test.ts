import assert from "node:assert/strict";
import test from "node:test";

import { activityForAssistantEvent, toolKind, workingStatusLabel, type AgentActivity } from "./working-status";

// Mesma sequência do onDelta/onDiscard do use-atlas-chat: o indicador acompanha o evento.
test("assistant_discard expõe a fase 'revising' enquanto a resposta é refeita", () => {
	let activity: AgentActivity = activityForAssistantEvent("assistant_delta");
	assert.equal(activity.phase, "writing");

	activity = activityForAssistantEvent("assistant_discard");
	assert.equal(activity.phase, "revising");
	assert.equal(workingStatusLabel("Atlas", activity), "Revisando a resposta…");
});

test("novos deltas depois do descarte trocam 'revising' por 'writing'", () => {
	let activity = activityForAssistantEvent("assistant_discard");
	assert.equal(activity.phase, "revising");

	activity = activityForAssistantEvent("assistant_delta");
	assert.equal(activity.phase, "writing");
	assert.equal(workingStatusLabel("Atlas", activity), "Atlas está escrevendo");
});

test("o indicador de trabalho fala o idioma do tradutor", async () => {
	const { createTranslator } = await import("./i18n/translator");
	const { loadMessages } = await import("./i18n/messages");
	const en = createTranslator("en-US", await loadMessages("en-US"));
	const es = createTranslator("es-ES", await loadMessages("es-ES"));
	assert.equal(workingStatusLabel("Atlas", { phase: "writing" }, undefined, en), "Atlas is writing");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "navigate", step: 1, maxSteps: 8 }, undefined, en), "Atlas is searching (step 2 of 8)");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "screenshot" }, undefined, es), "Atlas está mirando la pantalla");
	assert.equal(workingStatusLabel("Atlas", { phase: "thinking" }, { status: "waiting_user" }, en), "Atlas is waiting for you");
	assert.equal(workingStatusLabel("Atlas", { phase: "revising" }, undefined, en), "Revising the answer…");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "memory", step: 0, maxSteps: 3 }), "Atlas está consultando a memória (passo 1 de 3)");
});

// O avatar passou a usar a mesma classificação; o texto do indicador não pode mudar por causa disso.
test("toolKind: ferramentas novas no avatar não mudam a frase do indicador", () => {
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "web_search" }), "Atlas está trabalhando");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "browser_act" }), "Atlas está trabalhando");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "edit_file" }), "Atlas está trabalhando");
	assert.equal(workingStatusLabel("Atlas", { phase: "tool", tool: "navigate" }), "Atlas está pesquisando");
	assert.equal(toolKind("web_search"), "web");
	assert.equal(toolKind("edit_file"), "code");
	assert.equal(toolKind("shell"), "run");
});
