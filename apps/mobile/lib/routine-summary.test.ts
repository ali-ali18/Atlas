import type { RoutineGroupRecord, RoutineRecord } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { cronSentence, groupRoutines, groupSummary, routineSummary } from "./routine-summary";

const base = { botId: "b", groupId: null, enabled: true, schedule: "", timezone: "America/Sao_Paulo", lastRunAt: null } as unknown as RoutineRecord;
const routine = (patch: Record<string, unknown>) => ({ ...base, id: "r", name: "n", triggerType: "cron", ...patch }) as unknown as RoutineRecord;
const group = (id: string): RoutineGroupRecord => ({ id, botId: "b", name: id, description: "", createdAt: "", updatedAt: "", routineCount: 0, enabledCount: 0 });

describe("frase do gatilho", () => {
	it("cron legível vira frase; ilegível não mostra o cron cru", () => {
		expect(cronSentence("0 9 * * 1-5")).toBe("Nos dias úteis às 9:00");
		expect(cronSentence("0 9 * * *")).toBe("Todos os dias às 9:00");
		expect(cronSentence("0 9 1 * *")).toBe("Todo dia 1 às 9:00");
		expect(cronSentence("*/50 * * * *")).toBe("A cada 50 minutos");
		expect(cronSentence("3 4 5 6 7 8")).toBe("Em um agendamento");
	});
	it("uma vez e intervalo usam os formatadores do shared", () => {
		expect(routineSummary(routine({ triggerType: "once", once: { runAt: "2026-10-03T13:00:00.000Z" } }))).toBe("Uma vez · 03/10 às 10:00");
		expect(routineSummary(routine({ triggerType: "interval", interval: { everyMinutes: 50 } }))).toBe("A cada 50 min");
	});
	it("eventos e sem gatilho", () => {
		expect(routineSummary(routine({ triggerType: "event" }))).toBe("Webhook");
		expect(routineSummary(routine({ triggerType: "event", github: { repo: "org/repo" } }))).toBe("GitHub · org/repo");
		expect(routineSummary(routine({ triggerType: "cron", schedule: "" }))).toBe("Sem gatilho");
	});
});

describe("grupos", () => {
	it("singular e plural", () => {
		expect(groupSummary(1, 1)).toBe("1 de 1 ativa");
		expect(groupSummary(2, 3)).toBe("2 de 3 ativas");
	});
	it("mistura soltas e grupos na ordem; grupo vazio vai ao fim; grupo desconhecido vira solta", () => {
		const list = groupRoutines([routine({ id: "a" }), routine({ id: "b", groupId: "g1" }), routine({ id: "c", groupId: "g1" }), routine({ id: "d", groupId: "x" })], [group("g1"), group("g2")]);
		expect(list.map((entry) => (entry.kind === "group" ? `g:${entry.group.id}:${entry.routines.length}` : `r:${entry.routine.id}`))).toEqual(["r:a", "g:g1:2", "r:d", "g:g2:0"]);
	});
});
