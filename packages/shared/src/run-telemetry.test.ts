import { describe, expect, it } from "vitest";
import {
	applyLateRunUsage,
	applyReconciledCost,
	formatCostLabel,
	percentile,
	servedModelNote,
	stepTelemetryOf,
	summarizeRunTelemetry,
	type StepTelemetry,
} from "./run-telemetry.js";

const model = (t: Partial<StepTelemetry>) => ({
	type: "model",
	outputJson: { content: "SEGREDO-NAO-VAZAR", telemetry: { v: 1, ...t } },
});

describe("percentile", () => {
	it("vazio, um valor e nearest-rank", () => {
		expect(percentile([], 50)).toBeNull();
		expect(percentile([7], 95)).toBe(7);
		expect(percentile([10, 20, 30, 40], 50)).toBe(20);
		expect(percentile([10, 20, 30, 40], 95)).toBe(40);
		expect(percentile([40, 10, 30, 20], 0)).toBe(10);
	});
});

describe("summarizeRunTelemetry", () => {
	it("run vazio ou sem telemetria devolve zeros e nulls", () => {
		const s = summarizeRunTelemetry([{ type: "model", outputJson: { content: "x" } }]);
		expect(s.model.count).toBe(0);
		expect(s.model.p50).toBeNull();
		expect(s.cacheRatio).toBeNull();
		expect(s.costUsd).toBeNull();
		expect(summarizeRunTelemetry([]).steps).toBe(0);
	});

	it("agrega modelo, TTFT, tool, overhead, retries, tokens e custo", () => {
		const s = summarizeRunTelemetry([
			model({ modelMs: 1000, ttftMs: 300, llmAttempts: 2, retryReasons: ["rate_limit"], requestedModel: "a/b", servedModel: "a/b", promptTokens: 100, completionTokens: 10, cachedTokens: 60, cacheWriteTokens: 20, costUsd: 0.01 }),
			model({ modelMs: 3000, ttftMs: 900, requestedModel: "a/b", servedModel: "c/d", promptTokens: 200, completionTokens: 20 }),
			{ type: "tool_result", outputJson: { summary: "ok", telemetry: { v: 1, toolMs: 500, toolName: "web_search" } } },
			{ type: "tool_result", durationMs: 70, outputJson: { summary: "ok" } },
			{ type: "checkpoint", outputJson: { telemetry: { v: 1, stepMs: 4000, overheadMs: 100 } } },
		]);
		expect(s.model).toMatchObject({ count: 2, totalMs: 4000, p50: 1000, p95: 3000 });
		expect(s.ttft).toMatchObject({ count: 2, p50: 300, p95: 900 });
		expect(s.tool.count).toBe(2);
		expect(s.toolsByName.web_search?.totalMs).toBe(500);
		expect(s.toolsByName.unknown?.totalMs).toBe(70);
		expect(s.overhead).toMatchObject({ count: 1, p50: 100 });
		expect(s.llmRetries).toBe(1);
		expect(s.retryReasons).toEqual({ rate_limit: 1 });
		expect(s.modelSwitches).toBe(1);
		expect(s.tokens).toEqual({ prompt: 300, completion: 30, cached: 60, cacheWrite: 20 });
		// F2: 60 de 300 tokens de prompt vieram do cache
		expect(s.cacheRatio).toBeCloseTo(0.2);
		// custo desconhecido nunca vira zero
		expect(s.costUsd).toBeCloseTo(0.01);
		expect(s.costUnknownSteps).toBe(1);
	});

	it("o resumo e o extrator não carregam conteúdo da mensagem", () => {
		const step = model({ modelMs: 5 });
		expect(JSON.stringify(stepTelemetryOf(step))).not.toContain("SEGREDO");
		expect(JSON.stringify(summarizeRunTelemetry([step]))).not.toContain("SEGREDO");
	});
});

describe("custo parcial", () => {
	it("summarizeRunTelemetry marca costPartial quando há passo sem custo", () => {
		const s = summarizeRunTelemetry([
			model({ modelMs: 10, costUsd: 0.02 }),
			model({ modelMs: 10 }),
			model({ modelMs: 10 }),
		]);
		expect(s.costUsd).toBeCloseTo(0.02);
		expect(s.costUnknownSteps).toBe(2);
		expect(s.costPartial).toBe(true);
	});

	it("sem passos desconhecidos o custo não é parcial", () => {
		const s = summarizeRunTelemetry([model({ modelMs: 10, costUsd: 0.02 })]);
		expect(s.costPartial).toBe(false);
	});

	it("formatCostLabel diz 'custo parcial: N chamadas sem custo'", () => {
		expect(formatCostLabel(0.5, 0)).toBe("US$ 0.5000");
		expect(formatCostLabel(0.5, 1)).toBe("US$ 0.5000 (custo parcial: 1 chamada sem custo)");
		expect(formatCostLabel(0.5, 3)).toContain("custo parcial: 3 chamadas sem custo");
		expect(formatCostLabel(null, 2)).toBe("custo desconhecido: 2 chamadas sem custo");
		expect(formatCostLabel(undefined, undefined)).toBe("custo não informado");
	});

	it("applyReconciledCost soma e decrementa; zera e deixa de ser parcial", () => {
		const a = applyReconciledCost({ costUsd: 0.1, costUnknownCalls: 2 }, 0.05);
		expect(a.costUsd).toBeCloseTo(0.15);
		expect(a.costUnknownCalls).toBe(1);
		const b = applyReconciledCost(a, 0.05);
		expect(b).not.toHaveProperty("costUnknownCalls");
		expect(applyReconciledCost({}, 0.3)).toEqual({ costUsd: 0.3 });
	});
});

describe("servedModelNote", () => {
	it("só aparece quando o servido difere do pedido", () => {
		expect(servedModelNote("a/b", "c/d")).toBe("c/d");
		expect(servedModelNote("a/b", " a/b ")).toBeNull();
		expect(servedModelNote("a/b", "a/b")).toBeNull();
	});
	it("ids ausentes ou vazios não mostram nada", () => {
		expect(servedModelNote("a/b", undefined)).toBeNull();
		expect(servedModelNote("a/b", "  ")).toBeNull();
		expect(servedModelNote(undefined, "c/d")).toBeNull();
		expect(servedModelNote(null, null)).toBeNull();
	});
});

it("plano não vira custo desconhecido ou USD zero, inclusive no uso misto", () => {
 const plan = model({modelMs:10, provider:"chatgpt", costKind:"plan"});
 expect(summarizeRunTelemetry([plan])).toMatchObject({costUsd:null, costUnknownSteps:0,costPartial:false});
 expect(summarizeRunTelemetry([plan,model({modelMs:10,costUsd:0.2}),model({modelMs:10})])).toMatchObject({costUsd:0.2,costUnknownSteps:1,costPartial:true});
});

describe("applyLateRunUsage", () => {
	it("soma o uso tardio sem criar campo que não existia nos dois lados", () => {
		const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0.01, telemetry: { v: 1 as const } };
		const next = applyLateRunUsage(usage, { promptTokens: 40, completionTokens: 2, totalTokens: 42, costUsd: 0.0005 });
		expect(next.promptTokens).toBe(140);
		expect(next.totalTokens).toBe(162);
		expect(next.costUsd).toBeCloseTo(0.0105, 10);
		expect("costUnknownCalls" in next).toBe(false);
		expect("cachedTokens" in next).toBe(false);
		// Pura: o original fica igual.
		expect(usage.promptTokens).toBe(100);
	});

	it("custo desconhecido soma em costUnknownCalls; nada a somar devolve igual", () => {
		const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
		expect(applyLateRunUsage(usage, { promptTokens: 5, totalTokens: 5, costUnknownCalls: 1 })).toEqual({ promptTokens: 6, completionTokens: 1, totalTokens: 7, costUnknownCalls: 1 });
		expect(applyLateRunUsage(usage, null)).toEqual(usage);
		expect(applyLateRunUsage(usage, { costUsd: Number.NaN })).toEqual(usage);
	});

	it("troca a telemetria quando vem uma nova (decisão do Jev registrada depois)", () => {
		const usage = { promptTokens: 1, completionTokens: 0, totalTokens: 1, telemetry: { v: 1 as const, setupMs: 5 } };
		const next = applyLateRunUsage(usage, null, { v: 1, setupMs: 5, jev: { calls: 1, totalMs: 9, answered: 1, unavailable: 0, inputTokens: 0, models: [], byFeature: {}, costUsd: null } });
		expect(next.telemetry).toMatchObject({ setupMs: 5, jev: { calls: 1 } });
	});
});
