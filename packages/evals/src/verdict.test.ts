import { describe, expect, it } from "vitest";
import { formatCell, formatDelta, summarize } from "./report.js";
import type { RunRecord } from "./trajectory.js";
import { diagnose, passRateDelta, strongMatcher, type ModelStat } from "./verdict.js";

const stat = (model: string, passes: number, runs = 3, errors = 0): ModelStat => ({ model, runs, passes, errors, failing: {}, costUsd: 0, costUnknown: false });
const STRONG = "anthropic/claude-sonnet-5-5";
const WEAK = "deepseek/deepseek-chat-v3.1";
const isStrong = strongMatcher();

describe("diagnóstico modelo x harness", () => {
	it("fortes por padrão e por lista", () => {
		expect(isStrong(STRONG)).toBe(true);
		expect(isStrong("openai/gpt-5")).toBe(true);
		expect(isStrong(WEAK)).toBe(false);
		expect(strongMatcher([WEAK])(WEAK)).toBe(true);
		expect(strongMatcher([WEAK])(STRONG)).toBe(false);
	});

	it("todos passam → ok; todos falham → harness/instruções", () => {
		expect(diagnose([stat(STRONG, 3), stat(WEAK, 3)], isStrong).verdict).toBe("ok");
		expect(diagnose([stat(STRONG, 0), stat(WEAK, 0)], isStrong).verdict).toBe("harness/instruções");
	});

	it("forte passa e fraco falha (total ou parcial) → modelo", () => {
		expect(diagnose([stat(STRONG, 3), stat(WEAK, 0)], isStrong)).toMatchObject({ verdict: "modelo", reason: expect.stringContaining(WEAK) });
		expect(diagnose([stat(STRONG, 3), stat(WEAK, 2)], isStrong).verdict).toBe("modelo");
	});

	it("forte varia entre repetições → instável", () => {
		expect(diagnose([stat(STRONG, 2), stat(WEAK, 3)], isStrong)).toMatchObject({ verdict: "instável", reason: expect.stringContaining(`${STRONG} 2/3`) });
	});

	it("forte falha onde fraco passa → inconclusivo (suspeita na expectativa)", () => {
		expect(diagnose([stat(STRONG, 0), stat(WEAK, 3)], isStrong).verdict).toBe("inconclusivo");
	});

	it("sem forte na lista: mistura 0/1 → modelo; um só modelo fraco falhando → indefinido", () => {
		expect(diagnose([stat("a/x", 3), stat("b/y", 0)], isStrong).verdict).toBe("modelo");
		expect(diagnose([stat(WEAK, 0)], isStrong).verdict).toBe("indefinido");
		expect(diagnose([stat(STRONG, 0)], isStrong).verdict).toBe("harness/instruções");
	});

	it("só erros de execução → erro de execução", () => {
		expect(diagnose([stat(STRONG, 0, 3, 3), stat(WEAK, 0, 3, 3)], isStrong).verdict).toBe("erro de execução");
		expect(diagnose([], isStrong).verdict).toBe("indefinido");
	});

	it("delta em pontos percentuais", () => {
		expect(passRateDelta(stat(WEAK, 1), stat(WEAK, 3))).toBe(67);
		expect(passRateDelta(stat(WEAK, 3), stat(WEAK, 0))).toBe(-100);
		expect(passRateDelta(undefined, stat(WEAK, 3))).toBeNull();
	});
});

const rec = (scenarioId: string, model: string, pass: boolean, variant = "base", failing: string[] = []): RunRecord => ({
	scenarioId,
	model,
	variant,
	repeat: 0,
	pass,
	checks: failing.map((name) => ({ name, pass: false })),
	trajectory: { costUsd: 0.01, costUnknown: false, unmocked: [], error: undefined } as unknown as RunRecord["trajectory"],
});

describe("resumo e matriz", () => {
	it("agrega por variante/cenário/modelo, conta verificações e dá veredito", () => {
		const summary = summarize(
			[rec("s1", STRONG, true), rec("s1", WEAK, false, "base", ["no_question"]), rec("s1", WEAK, false, "base", ["no_question", "language:en-US"]), rec("s1", STRONG, true)],
			{ isStrong, createdAt: "x" },
		);
		expect(summary.cells.base?.s1?.[WEAK]).toMatchObject({ runs: 2, passes: 0, failing: { no_question: 2, "language:en-US": 1 } });
		expect(summary.verdicts.base?.s1?.verdict).toBe("modelo");
		expect(summary.costUsd).toBeCloseTo(0.04);
		expect(formatCell(summary.cells.base?.s1?.[WEAK])).toBe("0/2 no_question(2) language:en-US(1)");
		expect(formatCell(summary.cells.base?.s1?.[STRONG])).toBe("2/2 ok");
		expect(formatCell(undefined)).toBe("-");
	});

	it("delta entre variantes", () => {
		const summary = summarize([rec("s1", WEAK, false), rec("s1", WEAK, true, "nova")], { isStrong });
		expect(formatDelta(summary, "base", summary, "nova")).toContain("+100 (0/1 → 1/1)");
	});
});
