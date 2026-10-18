import { describe, expect, it } from "vitest";
import { formatMemoryUsage, resolveOrchestratorMemoryChars } from "./memory-limits.js";
import { parseAccountConfig, validateAccountConfigPatch } from "./account-config.js";

describe("limite de memória do orquestrador", () => {
	it("padrão 6000; usa o da conta dentro de 2200 a 20000", () => {
		expect(resolveOrchestratorMemoryChars(null)).toBe(6000);
		expect(resolveOrchestratorMemoryChars({ reflection: { memoryChars: 12000 } })).toBe(12000);
		expect(resolveOrchestratorMemoryChars({ reflection: { memoryChars: 2200 } })).toBe(2200);
		expect(resolveOrchestratorMemoryChars({ reflection: { memoryChars: 100 } })).toBe(2200);
		expect(resolveOrchestratorMemoryChars({ reflection: { memoryChars: 99999 } })).toBe(20000);
		expect(resolveOrchestratorMemoryChars({ reflection: { memoryChars: "x" } })).toBe(6000);
	});

	it("a conta valida: mínimo 2200 (o limite dos outros bots), máximo 20000, inteiro", () => {
		expect(validateAccountConfigPatch({ reflection: { memoryChars: 6000 } }).ok).toBe(true);
		expect(validateAccountConfigPatch({ reflection: { memoryChars: 2200 } }).ok).toBe(true);
		expect(validateAccountConfigPatch({ reflection: { memoryChars: 20000 } }).ok).toBe(true);
		expect(validateAccountConfigPatch({ reflection: { memoryChars: 2199 } }).ok).toBe(false);
		expect(validateAccountConfigPatch({ reflection: { memoryChars: 20001 } }).ok).toBe(false);
		expect(validateAccountConfigPatch({ reflection: { memoryChars: 5000.5 } }).ok).toBe(false);
		expect(validateAccountConfigPatch({ reflection: { memoryChars: null } }).ok).toBe(true);
		expect(parseAccountConfig({ v: 1, reflection: { memoryChars: 50 } }).reflection).toBeUndefined();
	});

	it("uso exibido em pt-BR", () => {
		expect(formatMemoryUsage(3100, 6000)).toBe("3.100 de 6.000");
	});
});
