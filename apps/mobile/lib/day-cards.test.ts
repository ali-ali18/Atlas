import { describe, expect, it } from "vitest";
import { calendarWhen, dayPlanDayLabel, dayPlanErrorText, dayPlanSectionTitle, draftSavedNote, guestsText, triageDeadline, triageGroups, triageSummary } from "./day-cards";

describe("plano do dia", () => {
	it("seções e dia em pt-BR", () => {
		expect(dayPlanSectionTitle("commitments")).toBe("Compromissos");
		expect(dayPlanSectionTitle("emails")).toBe("E-mails que pedem ação");
		expect(dayPlanDayLabel("2026-11-05")).toBe("quinta-feira, 5 de novembro");
		expect(dayPlanDayLabel("lixo")).toBe("lixo");
	});
	it("só login expirado pede para reconectar; o resto é 'não consegui ler'", () => {
		expect(dayPlanErrorText({ source: "calendar", reason: "needs_connection" })).toBe("Reconecte o Google Agenda para eu ler seus compromissos.");
		expect(dayPlanErrorText({ source: "calendar", reason: "failed" })).toBe("Não consegui ler a agenda.");
	});
});

describe("agenda", () => {
	it("hora no fuso do dono; dia inteiro não depende do fuso", () => {
		expect(calendarWhen({ start: "2026-11-05T17:00:00.000Z", end: "2026-11-05T18:00:00.000Z", allDay: false }, "America/Sao_Paulo", false)).toBe("14:00–15:00");
		expect(calendarWhen({ start: "2026-11-05T17:00:00.000Z", end: "2026-11-05T18:00:00.000Z", allDay: false }, "America/Sao_Paulo")).toMatch(/^qui\.?,? 5 de nov\.? · 14:00–15:00$/);
		expect(calendarWhen({ start: "2026-11-15", end: "2026-11-16", allDay: true }, "Asia/Tokyo", false)).toBe("O dia todo");
	});
	it("convidados no singular e no plural", () => {
		expect(guestsText(1)).toBe("1 convidado");
		expect(guestsText(3)).toBe("3 convidados");
	});
});

describe("e-mail", () => {
	const entry = (id: string, category: "needs_action" | "fyi" | "ignore") => ({ id, category, summary: id });
	it("triagem em grupos na ordem do web; grupo vazio some", () => {
		const groups = triageGroups([entry("a", "ignore"), entry("b", "needs_action"), entry("c", "needs_action")]);
		expect(groups.map((g) => [g.title, g.items.length])).toEqual([["Precisa de ação", 2], ["Pode ignorar", 1]]);
		expect(triageSummary([entry("a", "fyi")])).toBe("Nada pede ação");
		expect(triageSummary([entry("b", "needs_action")])).toBe("1 precisa de ação");
		expect(triageSummary([entry("b", "needs_action"), entry("c", "needs_action")])).toBe("2 precisam de ação");
		expect(triageDeadline("2026-11-06T20:00:00.000Z")).toBe("Prazo: 06/11/2026");
	});
	it("o rascunho sempre diz que nada foi enviado", () => {
		expect(draftSavedNote("gmail", true)).toContain("Nada foi enviado");
		expect(draftSavedNote("bot", true)).toContain("caixa do bot");
		expect(draftSavedNote("gmail", false)).toContain("Nada foi enviado");
	});
});
