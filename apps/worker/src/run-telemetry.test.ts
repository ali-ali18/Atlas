import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeStepRecord } from "@workspace/agent-runtime";
import { createJevTelemetryCollector } from "@workspace/agent-runtime";
import {
	createRunTelemetryTracker,
	stepTelemetryFields,
	withRunTelemetry,
} from "./run-telemetry.js";

test("stepTelemetryFields: telemetria vai para outputJson.telemetry e durationMs/costUsd para as colunas", () => {
	const step: RuntimeStepRecord = {
		decisionIndex: 0,
		subIndex: 0,
		type: "model",
		status: "completed",
		durationMs: 1200,
		costUsd: 0.002,
		telemetry: { v: 1, modelMs: 1200, servedModel: "a/b" },
		outputJson: { content: "texto", toolCallIds: ["c1"] },
	};
	const fields = stepTelemetryFields(step);
	assert.equal(fields.durationMs, 1200);
	assert.equal(fields.costUsd, 0.002);
	assert.deepEqual(fields.outputJson, {
		content: "texto",
		toolCallIds: ["c1"],
		telemetry: { v: 1, modelMs: 1200, servedModel: "a/b" },
	});
});

test("stepTelemetryFields: passo sem telemetria não muda o outputJson e custo ausente fica ausente", () => {
	const step: RuntimeStepRecord = {
		decisionIndex: 0,
		subIndex: 98,
		type: "checkpoint",
		status: "completed",
		outputJson: { offeredTools: ["navigate"] },
	};
	const fields = stepTelemetryFields(step);
	assert.deepEqual(fields.outputJson, { offeredTools: ["navigate"] });
	assert.equal("durationMs" in fields, false);
	assert.equal("costUsd" in fields, false);
});

test("stepTelemetryFields: telemetria sem outputJson cria só { telemetry }", () => {
	const fields = stepTelemetryFields({
		decisionIndex: 0,
		subIndex: 99,
		type: "checkpoint",
		status: "completed",
		telemetry: { v: 1, stepMs: 10, overheadMs: 3 },
	});
	assert.deepEqual(fields.outputJson, { telemetry: { v: 1, stepMs: 10, overheadMs: 3 } });
});

test("tracker: setup = lease até o INÍCIO da 1a chamada ao modelo; pós = fim do runtime até a gravação", () => {
	let t = 0;
	const tracker = createRunTelemetryTracker(() => t);
	t = 100;
	tracker.markLeaseAcquired();
	// ignora passos que não são do modelo
	t = 150;
	tracker.onStep({ decisionIndex: 0, subIndex: 98, type: "checkpoint", status: "completed" });
	// 1o passo do modelo termina em t=1500 e levou 1000ms → começou em 500 → setup 400
	t = 1500;
	tracker.onStep({
		decisionIndex: 0, subIndex: 0, type: "model", status: "completed",
		telemetry: { v: 1, modelMs: 1000 },
	});
	// o 2o passo de modelo não altera o setup
	t = 9000;
	tracker.onStep({ decisionIndex: 1, subIndex: 0, type: "model", status: "completed", telemetry: { v: 1, modelMs: 10 } });
	t = 10000;
	tracker.markRuntimeDone();
	t = 10250;
	tracker.markBeforeFinalWrite();
	assert.deepEqual(tracker.meta(), { v: 1, setupMs: 400, postMs: 250 });
});

test("withRunTelemetry: Jev fica em telemetry.jev, sem somar no uso; sem uso não inventa uso", () => {
	const jev = createJevTelemetryCollector();
	jev.record({ feature: "intent", mode: "shadow", source: "jev", durationMs: 80, model: "jev-1", inputTokens: 12 });
	const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
	const tracker = createRunTelemetryTracker(() => 0);
	const merged = withRunTelemetry(usage, tracker.meta(jev.snapshot()))!;
	assert.equal(merged.totalTokens, 15);
	assert.equal(merged.costUsd, undefined);
	assert.equal(merged.telemetry?.jev?.calls, 1);
	assert.equal(merged.telemetry?.jev?.costUsd, null);
	assert.equal(withRunTelemetry(undefined, tracker.meta()), undefined);
});

test("redação: nada de conteúdo no que o worker persiste", () => {
	const jev = createJevTelemetryCollector();
	jev.record({ feature: "tools", mode: "on", source: "jev", answers: { q: 0.7 }, durationMs: 5, model: "jev-1" });
	const tracker = createRunTelemetryTracker(() => 0);
	const dump = JSON.stringify(
		withRunTelemetry(
			{ promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			tracker.meta(jev.snapshot()),
		),
	);
	assert.equal(dump.includes("answers"), false);
});

test("A7: tracker propaga o pedido e o último modelo servido para o usageJson do run", () => {
	const tracker = createRunTelemetryTracker(() => 0);
	tracker.onStep({
		decisionIndex: 0, subIndex: 0, type: "model", status: "completed",
		telemetry: { v: 1, modelMs: 10, requestedModel: "a/b", servedModel: "a/b" },
	});
	// fallback do provider no 2o passo; passo de tool não mexe no modelo servido
	tracker.onStep({
		decisionIndex: 1, subIndex: 0, type: "model", status: "completed",
		telemetry: { v: 1, modelMs: 10, requestedModel: "a/b", servedModel: "c/d" },
	});
	tracker.onStep({
		decisionIndex: 1, subIndex: 1, type: "tool", status: "completed",
		telemetry: { v: 1, toolName: "navigate" },
	});
	const meta = tracker.meta();
	assert.equal(meta.requestedModel, "a/b");
	assert.equal(meta.servedModel, "c/d");
	assert.equal(withRunTelemetry({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, meta)?.telemetry?.servedModel, "c/d");
});
