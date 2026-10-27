import { describe, expect, it } from "vitest";
import { CONNECTOR_ARGS_GUIDANCE } from "./computer-use.js";

/** Regra de lote honesto no bloco de conectores (só entra no prompt de quem tem conector). */
describe("lote de escritas em conector", () => {
	it("manda dizer a contagem e não afirmar que as outras 'não rodaram'", () => {
		expect(CONNECTOR_ARGS_GUIDANCE).toContain("say the count up front and report progress");
		expect(CONNECTOR_ARGS_GUIDANCE).toContain("skipped, not failed");
		expect(CONNECTOR_ARGS_GUIDANCE).toContain('never say they "did not run"');
		expect(CONNECTOR_ARGS_GUIDANCE).toContain("without asking again");
	});

	it("a regra é curta (o bloco de conectores não cresce mais que ~450 caracteres)", () => {
		const line = CONNECTOR_ARGS_GUIDANCE.split("\n").find((entry) => entry.includes("Batches of similar writes"));
		expect(line).toBeDefined();
		expect(line!.length).toBeLessThan(550);
	});
});
