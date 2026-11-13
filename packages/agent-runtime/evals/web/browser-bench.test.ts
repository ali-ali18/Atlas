import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARMS, AGENT_BROWSER_SUFFIX, assertRealAllowed, estimateCost, parseBenchArgs, pickWinner, renderBenchMarkdown, runBench, type ArmRow } from "./browser-bench.js";

const row = (arm: ArmRow["arm"], successes: number, over: Partial<ArmRow> = {}): ArmRow => ({ arm, task: "T11", model: "m", runs: 3, successes, score: successes / 3, decisions: 10, promptTokens: 1000, peakPromptTokens: 2000, costUsd: 1, ...over });

describe("browser-bench: argumentos e custo", () => {
	it("padrões: os dois braços, T11, 3 repetições, nenhum teto (modo real recusado)", () => {
		const o = parseBenchArgs([]);
		expect(o).toMatchObject({ arms: [...ARMS], tasks: ["T11"], reps: 3, dry: false, real: false, maxCostUsd: 0 });
		expect(() => assertRealAllowed({ ...o, real: true }, {})).toThrow(/ATLAS_BENCH_OWNER_OK/);
		expect(() => assertRealAllowed({ ...o, real: true }, { ATLAS_BENCH_OWNER_OK: "1" })).toThrow(/max-cost/);
		expect(() => assertRealAllowed({ ...o, real: true, maxCostUsd: 3 }, { ATLAS_BENCH_OWNER_OK: "1" })).not.toThrow();
		expect(() => assertRealAllowed(o, {})).not.toThrow();
	});
	it("braço desconhecido falha", () => {
		expect(() => parseBenchArgs(["--arms", "current,playwright"])).toThrow(/braço desconhecido/);
	});
	it("estimativa: runs × passos × tokens × preço", () => {
		const o = parseBenchArgs(["--reps", "3", "--est-steps", "25", "--est-prompt-tokens", "12000", "--est-completion-tokens", "300", "--price-in", "1", "--price-out", "5"]);
		const e = estimateCost(o);
		expect(e.runs).toBe(6);
		expect(e.perRunUsd).toBeCloseTo((25 * (12_000 * 1 + 300 * 5)) / 1_000_000, 6);
		expect(e.totalUsd).toBeCloseTo(e.perRunUsd * 6, 6);
	});
	it("o braço agent-browser manda usar só o CLI da VM", () => {
		expect(AGENT_BROWSER_SUFFIX).toContain("agent-browser");
		expect(AGENT_BROWSER_SUFFIX).toContain("Do not use the browser_* tools");
	});
});

describe("browser-bench: fica o que acerta mais", () => {
	it("mais acertos ganha, mesmo custando mais", () => {
		expect(pickWinner([row("current", 3, { costUsd: 5 }), row("agent-browser", 2, { costUsd: 0.1 })]).winner).toBe("current");
		expect(pickWinner([row("current", 2), row("agent-browser", 3, { costUsd: 9 })]).winner).toBe("agent-browser");
	});
	it("empate no acerto é tie e o navegador atual fica: custo e nota não desempatam (regra do dono)", () => {
		expect(pickWinner([row("current", 3, { costUsd: 2 }), row("agent-browser", 3, { costUsd: 1 })]).winner).toBe("tie");
		expect(pickWinner([row("current", 3, { costUsd: 1 }), row("agent-browser", 3, { costUsd: 9 })]).winner).toBe("tie");
		expect(pickWinner([row("current", 2, { score: 0.2 }), row("agent-browser", 2, { score: 0.9 })]).winner).toBe("tie");
		const md = renderBenchMarkdown([row("current", 3, { costUsd: 2 }), row("agent-browser", 3, { costUsd: 1 })], { dry: false, startedAt: "x", spentUsd: 1 });
		expect(md).toContain("**Fica:** current (empate no acerto");
	});
});

describe("browser-bench --dry", () => {
	it("roda os dois braços na fixture de 1.000 comentários sem VM, sem modelo e sem chave", async () => {
		const options = { ...parseBenchArgs(["--dry", "--reps", "1"]), outDir: mkdtempSync(join(tmpdir(), "bench-")) };
		const out = await runBench(options, () => undefined);
		expect(out.rows.map((r) => r.arm).sort()).toEqual(["agent-browser", "current"]);
		for (const r of out.rows) expect(r).toMatchObject({ task: "T11", runs: 1, successes: 1 });
		expect(out.markdown).toContain("DRY");
		expect(out.spentUsd).toBeLessThan(0.01);
	});
});
