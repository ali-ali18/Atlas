import { describe, expect, it } from "vitest";
import {
	CHILD_TOOL_RESULT_MAX_CHARS,
	buildFallbackReport,
	childBudgetSpentRatio,
	clipChildToolResult,
	shouldSendWrapUpNote,
	shouldStopForSummary,
} from "./subagent-budget.js";

describe("subagent-budget", () => {
	it("nota de fechamento a partir de 75% de tokens, passos ou tempo", () => {
		expect(shouldSendWrapUpNote({ tokens: { used: 149_000, max: 200_000 } })).toBe(false);
		expect(shouldSendWrapUpNote({ tokens: { used: 150_000, max: 200_000 } })).toBe(true);
		expect(shouldSendWrapUpNote({ steps: { used: 23, max: 30 } })).toBe(true);
		expect(shouldSendWrapUpNote({ wall: { elapsedMs: 400_000, maxMs: 480_000 } })).toBe(true);
		expect(childBudgetSpentRatio({})).toBe(0);
	});

	it("para para resumir em 85% de tokens, 90% do tempo ou quando o próximo passo não deixa reserva", () => {
		expect(shouldStopForSummary({ tokens: { used: 169_000, max: 200_000 } })).toBe(false);
		expect(shouldStopForSummary({ tokens: { used: 170_000, max: 200_000 } })).toBe(true);
		expect(shouldStopForSummary({ tokens: { used: 150_000, max: 200_000 }, lastStepTokens: 30_000 })).toBe(true);
		expect(shouldStopForSummary({ wall: { elapsedMs: 432_000, maxMs: 480_000 } })).toBe(true);
		expect(shouldStopForSummary({})).toBe(false);
	});

	it("corta resultado grande com marcador e não mexe no pequeno", () => {
		expect(clipChildToolResult("abc")).toBe("abc");
		const clipped = clipChildToolResult("y".repeat(CHILD_TOOL_RESULT_MAX_CHARS + 500));
		expect(clipped.endsWith("[truncated 500 chars]")).toBe(true);
	});

	it("relatório de emergência: só sucessos, trechos de 300 chars, segredos redigidos", () => {
		expect(buildFallbackReport([])).toBeUndefined();
		expect(buildFallbackReport([{ name: "t", ok: false, summary: "erro" }])).toBeUndefined();
		const report = buildFallbackReport([
			{ name: "a", ok: true, summary: "z".repeat(1000) },
			{ name: "b", ok: false, summary: "falhou" },
			{ name: "c", ok: true, summary: "Bearer abcdefghijklmnop1234567890 ok" },
		])!;
		expect(report).toContain(`- a: ${"z".repeat(300)}…`);
		expect(report).not.toContain("falhou");
		expect(report).not.toContain("abcdefghijklmnop1234567890");
	});
});
