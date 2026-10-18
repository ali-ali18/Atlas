import { describe, expect, it } from "vitest";
import { createExecutionLedger } from "./execution/ledger.js";
import { hasVerifiableProgress, toolArgsKey, toolResultKey, type ToolOutcome } from "./progress.js";

const outcome = (step: number, summary: string): ToolOutcome => ({
	name: "list_items",
	argsKey: toolArgsKey("list_items", { step }),
	resultKey: toolResultKey(summary, true),
	ok: true,
	step,
});

describe("hasVerifiableProgress com evidência do ledger (L6)", () => {
	const outcomes = [outcome(0, "a"), outcome(1, "b"), outcome(2, "c")];

	it("sem ledger mantém o comportamento: resultado ok qualquer é ganho", () => {
		expect(hasVerifiableProgress(outcomes, 0)).toBe(true);
	});

	it("com ledger, ganho exige ids ou conteúdo novos na janela", () => {
		const ledger = createExecutionLedger();
		ledger.observe({ step: 0, tool: "list_items", argKey: "k", ok: true, resultText: JSON.stringify([{ id: 1 }]) });
		for (const step of [1, 2]) {
			ledger.observe({ step, tool: "list_items", argKey: "k", ok: true, resultText: JSON.stringify([{ id: 1 }]) });
		}
		expect(hasVerifiableProgress(outcomes, 0, ledger)).toBe(true);
		expect(hasVerifiableProgress(outcomes, 1, ledger)).toBe(false);
		ledger.observe({ step: 2, tool: "list_items", argKey: "k2", ok: true, resultText: JSON.stringify([{ id: 2 }]) });
		expect(hasVerifiableProgress(outcomes, 1, ledger)).toBe(true);
	});

	it("janela vazia segue sem ganho", () => {
		expect(hasVerifiableProgress(outcomes, 3, createExecutionLedger())).toBe(false);
	});
});
