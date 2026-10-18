import { describe, expect, it } from "vitest";
import { jevMcpState, reviewMcpWithJev } from "./jev-gate.js";

const state = jevMcpState({ userRequest: "Crie evento", toolName: "create_event", actionClass: "write", args: { summary: "Teste", apiKey: "privada", nested: { password: "senha" } } });

describe("Jev MCP gate", () => {
	it("remove segredos dos argumentos enviados", () => {
		expect(state.arguments).toMatchObject({ apiKey: "[redacted]", nested: { password: "[redacted]" } });
	});
	it("shadow só observa; gate pede confirmação no mesmo resultado", async () => {
		const evaluator = async () => ({ model: "jev", alignment: 0.4, externalInstruction: 0.1, durationMs: 20 });
		expect((await reviewMcpWithJev({ mode: "shadow", evaluator, state })).ask).toBe(false);
		expect((await reviewMcpWithJev({ mode: "gate", evaluator, state })).ask).toBe(true);
	});
	it("gate confirma em falha ou resposta inválida", async () => {
		const unavailable = await reviewMcpWithJev({ mode: "gate", state });
		expect(unavailable).toMatchObject({ ask: true, audit: { result: "unavailable" } });
		const invalid = await reviewMcpWithJev({ mode: "gate", state, evaluator: async () => ({ model: "jev", alignment: NaN, externalInstruction: 0, durationMs: 1 }) });
		expect(invalid.ask).toBe(true);
	});
});
