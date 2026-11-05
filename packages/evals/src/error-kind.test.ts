import { describe, expect, it } from "vitest";
import { classifyRunError, RUNTIME_TIMEOUT_MESSAGES } from "./error-kind.js";
import type { RecordedModelCall } from "./trajectory.js";

const call = (over: Partial<RecordedModelCall>): RecordedModelCall => ({ index: 0, kind: "main", model: "m", messages: [], tools: [], durationMs: 1, ...over });

describe("classifyRunError (auditoria F0, C1)", () => {
	it("sem erro: nada", () => {
		expect(classifyRunError({ modelCalls: [call({})] })).toBeUndefined();
	});

	it("o prazo do próprio eval é corte de tempo do runtime", () => {
		expect(classifyRunError({ error: "tempo esgotado (180s)", timedOut: true, modelCalls: [] })).toBe("runtime_timeout");
	});

	it.each([...RUNTIME_TIMEOUT_MESSAGES])("identificador do runtime %j vira runtime_timeout", (message) => {
		expect(classifyRunError({ error: message, modelCalls: [call({ error: message })] })).toBe("runtime_timeout");
	});

	it("DOMException TimeoutError (pelo name) vira runtime_timeout mesmo com outra mensagem", () => {
		expect(classifyRunError({ error: "The operation timed out", errorName: "TimeoutError", modelCalls: [call({ error: "The operation timed out", errorName: "TimeoutError" })] })).toBe("runtime_timeout");
	});

	it("erro HTTP/transporte da chamada ao modelo vira provider", () => {
		const message = "OpenCode Go está indisponível no momento (HTTP 429).";
		expect(classifyRunError({ error: message, errorName: "Error", modelCalls: [call({ error: message, errorName: "Error" })] })).toBe("provider");
	});

	it("o erro vem da chamada que falhou, não de um timeout antigo que foi recuperado", () => {
		const calls = [call({ index: 0, error: "First event or idle timeout", errorName: "TimeoutError" }), call({ index: 1, error: "HTTP 503", errorName: "Error" })];
		expect(classifyRunError({ error: "HTTP 503", errorName: "Error", modelCalls: calls })).toBe("provider");
	});

	it("erro que não veio de chamada ao modelo (falha do runtime ou do cenário) fica como falha da execução, sem tipo", () => {
		expect(classifyRunError({ error: "sem sandbox no eval", errorName: "Error", modelCalls: [call({})] })).toBeUndefined();
	});

	it("texto do modelo que cita 'timeout' não muda nada (sem regex)", () => {
		expect(classifyRunError({ error: "o modelo falou: First event or idle timeout depois", modelCalls: [call({})] })).toBeUndefined();
	});
});
