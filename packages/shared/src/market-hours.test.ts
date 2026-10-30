import { describe, expect, it } from "vitest";
import { B3_HOLIDAYS_2026, b3Session, isB3Open, isB3UsDstSchedule, quoteCheckDecision } from "./market-hours.js";

/** Instante a partir de um horário de Brasília (UTC-3). */
const brt = (iso: string) => new Date(`${iso}-03:00`);

describe("grade da B3", () => {
	it("horário de verão dos EUA: regular 10h–16h55, leilão até 17h", () => {
		// quinta, 15/10/2026
		expect(isB3Open(brt("2026-10-15T09:59:00"))).toBe(false);
		expect(b3Session(brt("2026-10-15T09:50:00")).phase).toBe("pre_open");
		expect(isB3Open(brt("2026-10-15T10:00:00"))).toBe(true);
		expect(isB3Open(brt("2026-10-15T16:59:00"))).toBe(true);
		expect(b3Session(brt("2026-10-15T17:00:00")).phase).toBe("after_close");
	});

	it("a partir de 03/11/2026 o regular vai até 17h55 e o leilão até 18h, sem after-market", () => {
		expect(isB3UsDstSchedule("2026-11-01")).toBe(true);
		expect(isB3UsDstSchedule("2026-11-03")).toBe(false);
		expect(isB3Open(brt("2026-11-03T17:30:00"))).toBe(true);
		expect(isB3Open(brt("2026-11-03T17:59:00"))).toBe(true);
		expect(b3Session(brt("2026-11-03T18:00:00")).phase).toBe("after_close");
		expect(b3Session(brt("2026-11-03T12:00:00")).schedule.afterMarket).toBeNull();
	});

	it("a grade de verão começa na segunda depois do 2º domingo de março", () => {
		expect(isB3UsDstSchedule("2026-03-08")).toBe(false); // domingo da virada
		expect(isB3UsDstSchedule("2026-03-09")).toBe(true);
		expect(isB3UsDstSchedule("2026-01-15")).toBe(false);
	});

	it("fim de semana e feriados não têm pregão", () => {
		expect(b3Session(brt("2026-10-31T11:00:00")).tradingDay).toBe(false); // sábado
		expect(b3Session(brt("2026-11-01T11:00:00")).tradingDay).toBe(false); // domingo
		for (const day of B3_HOLIDAYS_2026) {
			const date = brt(`${day}T11:00:00`);
			expect(isB3Open(date), day).toBe(false);
		}
		expect(b3Session(brt("2026-11-02T11:00:00")).tradingDay).toBe(false); // Finados
		expect(isB3Open(brt("2026-07-09T11:00:00"))).toBe(true); // feriado só de SP: B3 abre
	});

	it("converte o fuso: 13h UTC é 10h em Brasília", () => {
		expect(isB3Open(new Date("2026-10-15T13:00:00Z"))).toBe(true);
		expect(isB3Open(new Date("2026-10-15T12:59:00Z"))).toBe(false);
	});
});

describe("quoteCheckDecision", () => {
	it("confere durante o pregão", () => {
		expect(quoteCheckDecision(brt("2026-10-15T11:00:00"), "2026-10-15T13:50:00Z")).toEqual({ check: true, phase: "open" });
	});

	it("depois do fechamento confere uma vez só", () => {
		const first = quoteCheckDecision(brt("2026-10-15T17:05:00"), brt("2026-10-15T16:45:00").toISOString());
		expect(first).toEqual({ check: true, phase: "after_close" });
		const again = quoteCheckDecision(brt("2026-10-15T17:20:00"), brt("2026-10-15T17:05:00").toISOString());
		expect(again).toMatchObject({ check: false });
	});

	it("não confere à noite tardia, no fim de semana, antes da abertura nem em feriado", () => {
		expect(quoteCheckDecision(brt("2026-10-15T22:00:00"), null)).toMatchObject({ check: false });
		expect(quoteCheckDecision(brt("2026-10-15T09:50:00"), null)).toMatchObject({ check: false });
		expect(quoteCheckDecision(brt("2026-10-17T12:00:00"), null)).toMatchObject({ check: false });
		expect(quoteCheckDecision(brt("2026-11-02T12:00:00"), null)).toMatchObject({ check: false });
	});

	it("sem última conferência, o fechamento ainda é conferido", () => {
		expect(quoteCheckDecision(brt("2026-10-15T17:30:00"), undefined)).toMatchObject({ check: true });
	});
});
