import assert from "node:assert/strict";
import test from "node:test";

import { activityForAssistantEvent, workingStatusLabel, type AgentActivity } from "./working-status";

// Mesma sequência do onDelta/onDiscard do use-atlas-chat: o indicador acompanha o evento.
test("assistant_discard expõe a fase 'revising' e o texto descartado não aparece", () => {
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
