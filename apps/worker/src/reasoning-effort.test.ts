import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveRunReasoningEffort } from "./reasoning-effort.js";
import { followUpRequest } from "./follow-up.js";

describe("nível de raciocínio do run", () => {
	it("run (chat) > bot > conta > nada", () => {
		const snapshot = { reasoningEffort: "medium" as const };
		assert.equal(resolveRunReasoningEffort({ run: { budgetJson: { reasoningEffort: "high" } }, botPolicy: { reasoningEffort: "low" }, snapshot }), "high");
		assert.equal(resolveRunReasoningEffort({ run: { budgetJson: null }, botPolicy: { reasoningEffort: "low" }, snapshot }), "low");
		assert.equal(resolveRunReasoningEffort({ run: {}, botPolicy: null, snapshot }), "medium");
		assert.equal(resolveRunReasoningEffort({ run: {}, botPolicy: {}, snapshot: {} }), undefined);
	});

	it("subagente/rotina (sem o campo no run) usam o do bot, não o do chat", () => {
		const chatRun = { budgetJson: { reasoningEffort: "high", contextLength: 1000 } };
		const subagentRun = { budgetJson: { contextLength: 1000 } };
		const botPolicy = { reasoningEffort: "low" };
		assert.equal(resolveRunReasoningEffort({ run: chatRun, botPolicy, snapshot: {} }), "high");
		assert.equal(resolveRunReasoningEffort({ run: subagentRun, botPolicy, snapshot: {} }), "low");
	});

	it("valor corrompido no run é ignorado", () => {
		assert.equal(resolveRunReasoningEffort({ run: { budgetJson: { reasoningEffort: "ultra" } }, botPolicy: { reasoningEffort: "low" }, snapshot: {} }), "low");
	});

	it("o turno encadeado carrega o nível do chat; sem nível, nada", () => {
		const plan = { objective: "continue", attachments: [] } as unknown as Parameters<typeof followUpRequest>[1];
		const base = { model: "m", conversationId: "c", botId: "b", origin: "chat" as const };
		assert.equal(followUpRequest({ ...base, reasoningEffort: "low" }, plan).reasoningEffort, "low");
		assert.equal("reasoningEffort" in followUpRequest(base, plan), false);
	});
});
