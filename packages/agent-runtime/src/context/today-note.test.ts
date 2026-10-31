import { describe, expect, it } from "vitest";
import { todayNote } from "./today-note.js";

describe("todayNote", () => {
	it("usa a data local do fuso, não a UTC", () => {
		// 01:30 UTC de 20/10 ainda é 19/10 (segunda) em São Paulo.
		expect(todayNote(new Date("2026-10-20T01:30:00Z"))).toBe(
			"Automatic context, not a user message: do not reply to it, thank for it or mention it unless it matters to the request (dates, scheduling, reminders). Now is 2026-10-19 22:30 (segunda-feira), timezone America/Sao_Paulo. Resolve relative dates and times (hoje, ontem, mês anterior, até agora, esta semana, daqui a N minutos) against it.",
		);
	});

	it("inclui a hora local em 24h (meia-noite é 00:00, não 24:00)", () => {
		expect(todayNote(new Date("2026-10-25T17:32:00Z"))).toContain("Now is 2026-10-25 14:32 (domingo)");
		expect(todayNote(new Date("2026-10-25T03:05:00Z"))).toContain("Now is 2026-10-25 00:05");
	});

	it("usa o fuso informado (conta)", () => {
		expect(todayNote(new Date("2026-10-25T17:32:00Z"), "Asia/Tokyo")).toContain("Now is 2026-10-26 02:32 (segunda-feira), timezone Asia/Tokyo.");
	});

	it("fuso inválido, vazio ou ausente cai no padrão", () => {
		for (const zone of ["Mars/Olympus", "", null, undefined]) {
			expect(todayNote(new Date("2026-10-25T17:32:00Z"), zone)).toContain("Now is 2026-10-25 14:32 (domingo), timezone America/Sao_Paulo.");
		}
	});
});
