import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadScenarios } from "../scenario.js";
import { strongMatcher } from "../verdict.js";
import { runMatrix } from "./run.js";

/** F8.2: o seed de código roda em `matrix --engines v4 --simulate` com o repositório fixture real e o teste de verdade. */

const SCENARIOS_DIR = fileURLToPath(new URL("../../scenarios", import.meta.url));

describe("matrix --engines v4 --simulate: código", () => {
	it("lê, edita, roda o teste e vê passar (a 1ª execução falha de verdade)", async () => {
		const all = await loadScenarios(SCENARIOS_DIR, { recursive: true });
		const scenario = all.find((s) => s.id === "seed-codigo-corrigir-bug-com-teste")!;
		expect(scenario.run.engine).toBe("v4");
		const result = await runMatrix({ scenarios: [scenario], engines: ["v4"], models: ["anthropic/claude-sonnet-5-5"], mode: "simulate", capUsd: 100, isStrong: strongMatcher(), concurrency: 1 });
		const record = result.records[0]!;
		expect(result.runs[0]!.error).toBeUndefined();
		const tests = record.trajectory.toolResults.filter((r) => r.name === "code_test");
		expect(tests).toHaveLength(2);
		expect(tests[0]!.summary).toContain("Tests FAILED");
		expect(tests[1]!.summary).toContain("Tests PASSED");
		expect(record.trajectory.toolResults.find((r) => r.name === "code_edit")?.ok).toBe(true);
		expect(record.pass, JSON.stringify(record.checks?.filter((c: { pass: boolean }) => !c.pass))).toBe(true);
	});
});
