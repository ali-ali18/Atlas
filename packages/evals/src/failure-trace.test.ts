import { classifyRunFailure, type RunFailureToolCall } from "@workspace/shared";
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

	it("loop_stall_guard também vira model.loop e repetitionBlocked (auditoria F0, T3)", () => {
		const trace = failureTraceFromTrajectory(trajectory({ stop: { reason: "loop_stall_guard" } }));
		expect(trace.repetitionBlocked).toBe(true);
		expect(classifyRunFailure(trace).primary).toBe("model.loop");
		// outros motivos de parada não contam como repetição
		expect(failureTraceFromTrajectory(trajectory({ stop: { reason: "answered" } })).repetitionBlocked).toBe(false);
	});

	it("rede e VM só entram pelo `known` (a trajetória não grava) e vencem o que o modelo fez (auditoria F0, T3)", () => {
		expect(failureTraceFromTrajectory(trajectory()).transportErrors).toEqual([]);
		const network = failureTraceFromTrajectory(trajectory({ stop: { reason: "loop_repeat" } }), { transportErrors: [{ kind: "network", code: "ECONNRESET" }] });
		expect(classifyRunFailure(network)).toMatchObject({ primary: "env.network", all: ["env.network", "model.loop"] });
		const vm = failureTraceFromTrajectory(trajectory(), { transportErrors: [{ kind: "vm" }] });
		expect(classifyRunFailure(vm).primary).toBe("env.vm");
	});

	it("tool de fixture com ok:false é falha do cenário/modelo, não de ambiente: só o conector real conta como transporte (auditoria F0, T3)", () => {
		const sources = ["fixture", "unmocked", "real"] as const;
		for (const source of sources) {
			const trace = failureTraceFromTrajectory(trajectory({ toolResults: [{ id: "c1", name: "web_search", ok: false, summary: "x", source }] }));
			expect(trace.transportErrors).toEqual([]);
			expect(trace.steps[0]!.toolCalls[0]!.ok).toBe(false);
			expect(classifyRunFailure(trace).primary).toBe("none");
		}
		const connector = failureTraceFromTrajectory(trajectory({ toolResults: [{ id: "c1", name: "web_search", ok: false, summary: "x", source: "connector" }, { id: "c2", name: "web_search", ok: true, summary: "x", source: "connector" }] }));
		expect(connector.transportErrors).toEqual([{ kind: "connector" }]);
	});

	it("agrupa por `step` quando existe; chamadas sem `step` viram passos próprios depois (auditoria F0, B4)", () => {
		const tool = (id: string, step?: number) => ({ id, name: "web_search", args: {}, argsRaw: "{}", ...(step === undefined ? {} : { step }) });
		const result = (id: string, ok: boolean) => ({ id, name: "web_search", ok, summary: "", source: "fixture" as const });
		const trace = failureTraceFromTrajectory(
			trajectory({
				toolCalls: [tool("a", 2), tool("b"), tool("c", 0), tool("d", 2), tool("e")],
				toolResults: [result("a", true), result("b", false), result("c", true), result("d", false), result("e", true)],
			}),
		);
		const view = trace.steps.map((step) => step.toolCalls.map((item: RunFailureToolCall) => item.ok));
		// passo 0 = [c]; passo 2 = [a, d] (paralelas); sem passo = [b] e [e], cada uma sozinha, na ordem.
		expect(view).toEqual([[true], [true, false], [false], [true]]);
	});

	it("`known` tem precedência (insistência)", () => {
		const base = { declinedOffers: ["resumo-video"], offeredTopics: ["resumo-video"] };
		expect(classifyRunFailure(failureTraceFromTrajectory(trajectory(), base)).primary).toBe("model.nagging");
		expect(classifyRunFailure(failureTraceFromTrajectory(trajectory(), { ...base, staleTaskInjected: true })).primary).toBe("harness.stale_task_injection");
	});
});
