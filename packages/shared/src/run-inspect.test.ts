import { describe, expect, it } from "vitest";
import { buildRunInspection, type InspectRawStep } from "./run-inspect.js";

const tokens = { system: 100, tools: 50, history: 20, toolResults: 10, notes: 5, turn: 15 };
const step = (over: Partial<InspectRawStep>): InspectRawStep => ({ index: 0, decisionIndex: 0, subIndex: 0, type: "model", status: "completed", inputJson: null, outputJson: null, ...over });
const run = { id: "r1", status: "completed", model: "m", origin: "chat", error: null };

describe("buildRunInspection", () => {
	it("reconstrói as tools por delta e soma o uso", () => {
		const out = buildRunInspection({
			run,
			approvals: [],
			events: [],
			steps: [
				step({ outputJson: { finishReason: "tool_calls", telemetry: { v: 1, promptTokens: 200, completionTokens: 20, cachedTokens: 150, provider: "openrouter" }, inspect: { v: 1, tokens, total: 200, messages: 4, tools: { count: 2, names: ["a", "b"] }, actions: [{ kind: "collapsed", count: 3 }] } } }),
				step({ decisionIndex: 1, outputJson: { telemetry: { v: 1, promptTokens: 300, completionTokens: 30 }, inspect: { v: 1, tokens, total: 210, messages: 6, tools: { count: 2, added: ["c"], removed: ["a"] }, actions: [] } } }),
			],
		});
		expect(out.steps[0]).toMatchObject({ toolNames: ["a", "b"], cacheReadTokens: 150, provider: "openrouter", finishReason: "tool_calls" });
		expect(out.steps[0]!.actions).toEqual([{ kind: "collapsed", count: 3 }]);
		expect(out.steps[1]!.toolNames).toEqual(["b", "c"]);
		expect(out.totals).toMatchObject({ steps: 2, promptTokens: 500, completionTokens: 50 });
	});

	it("chamadas de tool: argumentos truncados, status e segredos mascarados", () => {
		const out = buildRunInspection({
			run,
			approvals: [],
			events: [],
			scrub: (text) => text.replace(/SEGREDO/g, "[Filtered]"),
			steps: [
				step({ decisionIndex: 1, subIndex: 1, type: "tool_result", status: "failed", durationMs: 12, idempotencyKey: "k1", inputJson: { name: "web_fetch", args: { url: "x", note: "SEGREDO".repeat(200) } }, outputJson: { ok: false, summary: "erro SEGREDO" } }),
				step({ decisionIndex: 1, subIndex: 2, type: "tool_result", idempotencyKey: "k2", inputJson: { name: "read", args: {} }, outputJson: { ok: true, summary: "ok" } }),
				step({ decisionIndex: 1, subIndex: 3, type: "tool", status: "running", idempotencyKey: "k3", inputJson: { name: "slow" } }),
			],
		});
		expect(out.toolCalls.map((c) => [c.name, c.status])).toEqual([["web_fetch", "failed"], ["read", "ok"], ["slow", "running"]]);
		expect(out.toolCalls[0]!.args!.length).toBeLessThanOrEqual(401);
		expect(JSON.stringify(out)).not.toContain("SEGREDO");
		expect(out.totals.failedToolCalls).toBe(1);
	});

	it("contexto, erros e aprovações", () => {
		const out = buildRunInspection({
			run: { ...run, error: "falhou" },
			steps: [],
			events: [
				{ seq: 1, type: "inspect_context", payload: { type: "inspect_context", transcript: { mode: "fallback", reason: "no_watermark" } } },
				{ seq: 2, type: "error", payload: { type: "error", error: "boom" } },
			],
			approvals: [
				{ id: "m1", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Enviar", status: "failed", outcome: { ok: false, detail: "sem permissão" } }) },
				{ id: "m2", content: "não é json" },
			],
		});
		expect(out.context).toEqual({ mode: "fallback", reason: "no_watermark" });
		expect(out.errors).toEqual([{ message: "boom" }]);
		expect(out.approvals).toEqual([{ id: "c1", title: "Enviar", status: "failed", detail: "sem permissão", ok: false }]);
		expect(out.error).toBe("falhou");
	});

	it("passo antigo sem inspect aparece só com a telemetria", () => {
		const out = buildRunInspection({ run, approvals: [], events: [], steps: [step({ outputJson: { telemetry: { v: 1, promptTokens: 9 } } })] });
		expect(out.steps[0]).toMatchObject({ promptTokens: 9, hasRequest: false, actions: [] });
		expect(out.steps[0]!.tokens).toBeUndefined();
	});
});
