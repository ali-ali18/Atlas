import { classifyRunFailure } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { failureTraceFromTrajectory } from "./failure-trace.js";
import type { RecordedModelCall, Trajectory } from "./trajectory.js";

const call = (over: Partial<RecordedModelCall>): RecordedModelCall => ({ index: 0, kind: "main", model: "m", messages: [], tools: ["web_search"], durationMs: 1, ...over });

const trajectory = (over: Partial<Trajectory> = {}): Trajectory => ({
	scenarioId: "s",
	model: "m",
	variant: "v",
	repeat: 0,
	startedAt: "2026-11-05T00:00:00Z",
	durationMs: 1,
	text: "",
	modelCalls: [call({ response: { content: null, toolCalls: [{ name: "web_search", arguments: "{}" }] } }), call({ index: 1, response: { content: "pronto" } })],
	toolCalls: [{ id: "c1", name: "web_search", args: {}, argsRaw: "{}", step: 0 }],
	toolResults: [{ id: "c1", name: "web_search", ok: true, summary: "ok", source: "fixture" }],
	events: [],
	visible: [],
	revised: [],
	discards: [],
	steerDelivered: [],
	unmocked: [],
	costUsd: 0,
	costUnknown: false,
	tokens: { prompt: 0, completion: 0 },
	...over,
});

describe("failureTraceFromTrajectory", () => {
	it("trajetória saudável: padrões conservadores, classificação none", () => {
		const trace = failureTraceFromTrajectory(trajectory({ stop: { reason: "answered" } }));
		expect(trace).toMatchObject({ staleTaskInjected: false, declinedOffers: [], openTaskItemsAtEnd: 0, endedWithoutTool: true, repetitionBlocked: false, compactionHappened: false });
		expect(trace.steps).toEqual([{ toolCalls: [{ name: "web_search", ok: true }] }]);
		expect(classifyRunFailure(trace).primary).toBe("none");
	});

	it("tool nunca oferecida vira hidden", () => {
		const trace = failureTraceFromTrajectory(trajectory({ toolCalls: [{ id: "c1", name: "sandbox_shell", args: {}, argsRaw: "{}", step: 0 }] }));
		expect(trace.steps[0]!.toolCalls[0]!.hidden).toBe(true);
		expect(classifyRunFailure(trace).primary).toBe("harness.tool_not_exposed");
	});

	it("parada com lista aberta e sem tool no fim vira announce_stop", () => {
		const trace = failureTraceFromTrajectory(trajectory({ stop: { reason: "answered", detail: "items_open" } }));
		expect(trace.openTaskItemsAtEnd).toBe(1);
		expect(classifyRunFailure(trace).primary).toBe("model.announce_stop");
	});

	it("loop_repeat vira model.loop e falha de conector vira env.connector", () => {
		expect(classifyRunFailure(failureTraceFromTrajectory(trajectory({ stop: { reason: "loop_repeat" } }))).primary).toBe("model.loop");
		const failing = trajectory({ toolResults: [{ id: "c1", name: "web_search", ok: false, summary: "502", source: "connector" }] });
		expect(classifyRunFailure(failureTraceFromTrajectory(failing)).primary).toBe("env.connector");
	});

	it("`known` tem precedência (insistência)", () => {
		const base = { declinedOffers: ["resumo-video"], offeredTopics: ["resumo-video"] };
		expect(classifyRunFailure(failureTraceFromTrajectory(trajectory(), base)).primary).toBe("model.nagging");
		expect(classifyRunFailure(failureTraceFromTrajectory(trajectory(), { ...base, staleTaskInjected: true })).primary).toBe("harness.stale_task_injection");
	});
});
