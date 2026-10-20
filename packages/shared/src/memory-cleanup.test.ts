import { describe, expect, it } from "vitest";
import { MEMORY_CLEANUP_STALE_MESSAGE, parseMemoryCleanupSuggestions, resolveMemoryCleanupStatus } from "./memory-cleanup.js";

describe("estado da revisão de memória", () => {
	const now = new Date("2026-10-20T12:00:00Z");
	it("revisando recente continua; velho demais vira falha com a mensagem fixa", () => {
		expect(resolveMemoryCleanupStatus({ status: "generating", requestedAt: new Date("2026-10-20T11:58:00Z") }, now)).toEqual({ status: "generating", error: null });
		expect(resolveMemoryCleanupStatus({ status: "generating", requestedAt: new Date("2026-10-20T11:50:00Z") }, now)).toEqual({ status: "failed", error: MEMORY_CLEANUP_STALE_MESSAGE });
		expect(resolveMemoryCleanupStatus({ status: "generating" }, now).status).toBe("failed");
	});
	it("falha mostra o motivo; sem estado não há nada", () => {
		expect(resolveMemoryCleanupStatus({ status: "failed", error: "Sem chave" }, now)).toEqual({ status: "failed", error: "Sem chave" });
		expect(resolveMemoryCleanupStatus({ status: "failed" }, now).error).toMatch(/revisar/);
		expect(resolveMemoryCleanupStatus({}, now)).toEqual({ status: null, error: null });
	});
});

describe("leitura das sugestões gravadas", () => {
	it("mantém as válidas e descarta o que não tem o formato (apagar sem entrada, fundir com uma só)", () => {
		const out = parseMemoryCleanupSuggestions([
			{ id: "a", kind: "delete", target: "memory", entryIds: ["e1"], before: ["x"], reason: "r", createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "b", kind: "merge", target: "user", entryIds: ["e1", "e2"], before: ["x", "y"], content: "xy", reason: "r" },
			{ id: "c", kind: "merge", target: "user", entryIds: ["e1"], content: "x" },
			{ id: "d", kind: "delete", target: "memory", entryIds: [] },
			{ id: "e", kind: "explodir", target: "memory", entryIds: ["e1"] },
			"lixo",
		]);
		expect(out.map((s) => s.id)).toEqual(["a", "b"]);
		expect(out[1]!.content).toBe("xy");
		expect(parseMemoryCleanupSuggestions(null)).toEqual([]);
	});
});
