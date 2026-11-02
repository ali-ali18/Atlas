import { describe, expect, it } from "vitest";
import { buildExecutions, executionState, executionStateLabel, executionTitle } from "./executions";

const item = (content: string) => ({ content, status: "completed" as const });

describe("estado da execução", () => {
	it("do status do run para uma palavra", () => {
		expect(executionState("completed")).toBe("done");
		expect(executionState("failed")).toBe("error");
		expect(executionState("cancelled")).toBe("stopped");
		expect(executionState("budget_exhausted")).toBe("stopped");
		expect(executionState("waiting_user")).toBe("waiting");
		expect(executionState("running")).toBe("running");
		expect(executionState("retrying")).toBe("running");
	});
	it("rótulos em pt-BR", () => {
		expect(["running", "waiting", "done", "error", "stopped"].map((state) => executionStateLabel(state as never))).toEqual(["Em andamento", "Esperando você", "Concluído", "Erro", "Parado"]);
	});
});

describe("título e lista", () => {
	it("título é a primeira tarefa; sem plano, a data", () => {
		expect(executionTitle([item("  Avatar engine RN analysis "), item("outra")], "2026-11-02T10:00:00.000Z")).toBe("Avatar engine RN analysis");
		expect(executionTitle([], "2026-11-02T10:00:00.000Z")).toMatch(/^Execução de \d\d\/\d\d \d\d:\d\d$/);
		expect(executionTitle([], "nada")).toBe("Execução");
	});
	it("junta cartões e runs, mais nova primeiro, sem repetir run", () => {
		const list = buildExecutions(
			[
				{ runId: "a", items: [item("Velha")], createdAt: "2026-11-01T10:00:00.000Z" },
				{ runId: "b", items: [item("Nova")], createdAt: "2026-11-02T10:00:00.000Z" },
				{ runId: "b", items: [item("Nova repetida")], createdAt: "2026-11-02T10:05:00.000Z" },
			],
			[
				{ id: "a", status: "failed", createdAt: "2026-11-01T10:00:00.000Z" },
				{ id: "b", status: "completed", createdAt: "2026-11-02T10:00:00.000Z" },
			],
		);
		expect(list.map((entry) => `${entry.title}:${entry.state}`)).toEqual(["Nova:done", "Velha:error"]);
	});
	it("run fora da lista de estados fica sem estado (não chuta)", () => {
		const [entry] = buildExecutions([{ runId: "x", items: [item("T")], createdAt: "2026-11-02T10:00:00.000Z" }], []);
		expect(entry?.state).toBeNull();
	});
});
