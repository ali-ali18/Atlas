import assert from "node:assert/strict";
import test from "node:test";
import type { DevTimingEvent } from "@workspace/shared";

import { applyDevHistory, applyDevTiming, devAverageFirstTokenMs, devTimingParts, type DevSessionMap } from "./reducer";

const S = "s1";
const timing = (extra: Partial<DevTimingEvent> = {}): DevTimingEvent => ({
	type: "dev_timing",
	sessionId: S,
	startedAt: 1_000_000,
	modelMs: 0,
	firstTokenMs: 0,
	toolsMs: 0,
	shellMs: 0,
	pollWaitMs: 0,
	setupMs: 0,
	approvalMs: 0,
	steps: 0,
	...extra,
});

test("dev_timing: cada run guarda o último evento e o painel soma os runs (inclui a espera de aprovação)", () => {
	let map: DevSessionMap = {};
	map = applyDevTiming(map, timing({ startedAt: 1_000_000, modelMs: 40_000, steps: 4, approvalPendingAt: 1_100_000 }), { at: 1, runId: "a" });
	map = applyDevTiming(map, timing({ startedAt: 1_000_000, modelMs: 80_000, shellMs: 30_000, pollWaitMs: 5_000, setupMs: 40_000, firstTokenMs: 9_600, steps: 8, approvalPendingAt: 1_100_000 }), { at: 2, runId: "a" });
	// evento antigo chegando depois (replay) não regride
	map = applyDevTiming(map, timing({ startedAt: 1_000_000, modelMs: 40_000, steps: 4 }), { at: 3, runId: "a" });
	map = applyDevTiming(map, timing({ startedAt: 1_280_000, modelMs: 50_000, shellMs: 25_000, pollWaitMs: 5_000, steps: 10 }), { at: 4, runId: "b" });
	const parts = devTimingParts(map[S]!);
	assert.deepEqual(parts?.map((p) => p.text), ["Modelo 2m10s", "Comandos 1m05s", "Esperando aprovação 3m00s", "Preparação 40s", "18 passos"]);
	assert.equal(devAverageFirstTokenMs(map[S]!), 533);
});

test("dev_timing: sessão sem eventos não mostra a seção; valores abaixo de 1s somem", () => {
	assert.equal(devTimingParts({}), null);
	const map = applyDevTiming({}, timing({ modelMs: 400, steps: 1 }), { at: 1, runId: "a" });
	assert.deepEqual(devTimingParts(map[S]!)?.map((p) => p.text), ["1 passo"]);
});

test("dev_timing: o histórico persistido reaplica o evento", () => {
	const map = applyDevHistory({}, [{ runId: "r1", seq: 3, type: "dev_timing", payload: { ...timing({ modelMs: 130_000, steps: 18 }) } as unknown as Record<string, unknown>, createdAt: new Date(1_000).toISOString() }]);
	assert.equal(devTimingParts(map[S]!)?.[0]?.text, "Modelo 2m10s");
});
