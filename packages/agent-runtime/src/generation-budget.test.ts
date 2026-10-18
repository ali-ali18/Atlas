import { expect, it } from "vitest";
import { agentOutputBudget } from "./generation-budget.js";

it("orçamento diferencia leitura de documento e respeita saldo/configuração explícitos", () => {
	expect(agentOutputBudget({ canCreateFiles: false })).toBe(4096);
	expect(agentOutputBudget({ canCreateFiles: true })).toBeUndefined();
	expect(agentOutputBudget({ canCreateFiles: true, configured: 8192 })).toBe(
		8192,
	);
	expect(agentOutputBudget({ canCreateFiles: true, remaining: 64 })).toBe(64);
	expect(
		agentOutputBudget({
			canCreateFiles: false,
			configured: 8192,
			remaining: 64,
		}),
	).toBe(64);
});

it("configuração inválida não é escondida por saldo menor", () => {
	for (const configured of [0, -1, NaN, Infinity, 1_000_001]) {
		expect(() =>
			agentOutputBudget({ canCreateFiles: true, configured, remaining: 64 }),
		).toThrow(RangeError);
	}
});
