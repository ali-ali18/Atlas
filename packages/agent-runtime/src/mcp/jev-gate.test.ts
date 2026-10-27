import { describe, expect, it } from "vitest";
import { jevMcpState, reviewMcpWithJev, summarizeApprovedAction } from "./jev-gate.js";

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
	it("gate confirma resposta inválida (e falha, se irreversível)", async () => {
		const unavailable = await reviewMcpWithJev({ mode: "gate", state: { ...state, actionClass: "irreversible" } });
		expect(unavailable).toMatchObject({ ask: true, audit: { result: "unavailable" } });
		const invalid = await reviewMcpWithJev({ mode: "gate", state: { ...state, actionClass: "irreversible" }, evaluator: async () => ({ model: "jev", alignment: NaN, externalInstruction: 0, durationMs: 1 }) });
		expect(invalid.ask).toBe(true);
	});
});

describe("Jev MCP gate: fora do ar e estado", () => {
	it("fora do ar não pergunta para escrita reversível; pergunta se irreversível ou com conteúdo externo", async () => {
		expect((await reviewMcpWithJev({ mode: "gate", state })).ask).toBe(false);
		const irreversible = jevMcpState({ userRequest: "x", toolName: "delete_event", actionClass: "irreversible", args: {} });
		expect((await reviewMcpWithJev({ mode: "gate", state: irreversible })).ask).toBe(true);
		expect((await reviewMcpWithJev({ mode: "gate", state, untrustedContent: true })).ask).toBe(true);
		expect((await reviewMcpWithJev({ mode: "gate", state })).audit).toMatchObject({ result: "unavailable" });
	});
	it("limites numéricos seguem os mesmos (0,9 de alinhamento, 0,2 de instrução externa)", async () => {
		const at = (alignment: number, externalInstruction: number) => reviewMcpWithJev({ mode: "gate", state, evaluator: async () => ({ model: "jev", alignment, externalInstruction, durationMs: 1 }) });
		expect((await at(0.9, 0.19)).ask).toBe(false);
		expect((await at(0.89, 0)).ask).toBe(true);
		expect((await at(1, 0.2)).ask).toBe(true);
	});
	it("neverAsk ignora o alinhamento mas não a instrução externa", async () => {
		const at = (alignment: number, externalInstruction: number) => reviewMcpWithJev({ mode: "gate", neverAsk: true, state, evaluator: async () => ({ model: "jev", alignment, externalInstruction, durationMs: 1 }) });
		expect((await at(0.1, 0)).ask).toBe(false);
		expect((await at(1, 0.5)).ask).toBe(true);
		expect((await reviewMcpWithJev({ mode: "gate", neverAsk: true, state, untrustedContent: true })).ask).toBe(false);
	});
	it("estado leva as ações já aprovadas, curtas e sem segredos", () => {
		const line = summarizeApprovedAction("create_event", { summary: "Prova de Cálculo", apiKey: "segredo", n: 3 });
		expect(line).toBe("create_event: Prova de Cálculo");
		const withApproved = jevMcpState({ userRequest: "x", toolName: "create_event", actionClass: "write", args: {}, alreadyApproved: Array.from({ length: 12 }, (_, i) => `a${i}`) });
		expect(withApproved.alreadyApproved).toHaveLength(8);
		expect(withApproved.alreadyApproved?.at(-1)).toBe("a11");
		expect(state.alreadyApproved).toBeUndefined();
	});
});
