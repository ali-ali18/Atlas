import { describe, expect, it } from "vitest";
import { todayNote } from "./today-note.js";

describe("todayNote", () => {
	it("usa a data local do fuso, não a UTC", () => {
		// 01:30 UTC de 20/10 ainda é 19/10 (segunda) em São Paulo.
		expect(todayNote(new Date("2026-10-20T01:30:00Z"))).toBe(
			"Today is 2026-10-19 (segunda-feira), timezone America/Sao_Paulo. Resolve relative dates (hoje, ontem, mês anterior, até agora, esta semana) against it.",
		);
	});
});
