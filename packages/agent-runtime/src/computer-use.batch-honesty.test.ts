import { describe, expect, it } from "vitest";
import { CONNECTOR_ARGS_GUIDANCE } from "./computer-use.js";

/**
 * Regra de lote honesto: NÃO fica no bloco de conectores (sempre carregado para quem tem conector).
 * Ela viaja no resultado do cartão de confirmação e no aviso de retomada depois da aprovação, ou seja,
 * só entra no contexto quando o lote realmente existe (regra 70: só entra no contexto se for usar).
 */
describe("lote de escritas em conector", () => {
	it("o bloco sempre carregado de conectores não leva a regra de lote nem de aprovação por tarefa", () => {
		expect(CONNECTOR_ARGS_GUIDANCE).not.toContain("Batches of similar writes");
		expect(CONNECTOR_ARGS_GUIDANCE).not.toContain("approves a tool for the task");
		expect(CONNECTOR_ARGS_GUIDANCE).not.toContain("did not run");
	});
});
