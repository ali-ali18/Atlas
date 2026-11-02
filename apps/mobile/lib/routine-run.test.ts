import { describe, expect, it } from "vitest";
import { formatRunTime, routineRunLabel } from "./routine-run";

describe("linha do histórico", () => {
	it("origem e estado", () => {
		expect(routineRunLabel({ triggeredBy: "schedule", status: "succeeded", error: null })).toBe("agendada · concluída");
		expect(routineRunLabel({ triggeredBy: "manual", status: "running", error: null })).toBe("manual · executando");
		expect(routineRunLabel({ triggeredBy: "event", status: "queued", error: null })).toBe("por evento · na fila");
	});
	it("pulada mostra o motivo guardado; falha traduz o erro técnico e não vaza o texto cru", () => {
		expect(routineRunLabel({ triggeredBy: "schedule", status: "skipped", error: "Rotina pausada" })).toBe("agendada · pulada · Rotina pausada");
		const failed = routineRunLabel({ triggeredBy: "schedule", status: "failed", error: "This request requires more credits, or fewer max_tokens" });
		expect(failed.startsWith("agendada · falhou · ")).toBe(true);
		expect(failed).not.toContain("max_tokens");
		expect(routineRunLabel({ triggeredBy: "schedule", status: "failed", error: null })).toBe("agendada · falhou");
	});
});

describe("hora da execução", () => {
	it("dia/mês e hora no fuso", () => {
		expect(formatRunTime("2026-10-03T13:05:00.000Z", "America/Sao_Paulo")).toBe("03/10 10:05");
	});
	it("data inválida vira vazio", () => {
		expect(formatRunTime("nada")).toBe("");
	});
});
