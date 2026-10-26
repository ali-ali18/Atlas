import { describe, expect, it } from "vitest";
import { DEFAULT_WORK_HOURS, isWithinWorkHours, nextWorkDayStart, parseWorkHours, readWorkHours } from "./work-hours.js";

const SP = "America/Sao_Paulo"; // UTC-3 o ano todo (sem horário de verão)
const iso = (d: Date) => d.toISOString();

describe("isWithinWorkHours", () => {
	// 2026-10-26 é segunda-feira.
	it("dentro do expediente num dia útil", () => {
		expect(isWithinWorkHours(new Date("2026-10-26T12:00:00Z"), DEFAULT_WORK_HOURS, SP)).toBe(true); // 09:00 local
	});
	it("o início conta, o fim não", () => {
		expect(isWithinWorkHours(new Date("2026-10-26T11:00:00Z"), DEFAULT_WORK_HOURS, SP)).toBe(true); // 08:00
		expect(isWithinWorkHours(new Date("2026-10-26T10:59:00Z"), DEFAULT_WORK_HOURS, SP)).toBe(false); // 07:59
		expect(isWithinWorkHours(new Date("2026-10-26T20:59:00Z"), DEFAULT_WORK_HOURS, SP)).toBe(true); // 17:59
		expect(isWithinWorkHours(new Date("2026-10-26T21:00:00Z"), DEFAULT_WORK_HOURS, SP)).toBe(false); // 18:00
	});
	it("fim de semana fica fora", () => {
		expect(isWithinWorkHours(new Date("2026-10-24T15:00:00Z"), DEFAULT_WORK_HOURS, SP)).toBe(false); // sábado
		expect(isWithinWorkHours(new Date("2026-10-25T15:00:00Z"), DEFAULT_WORK_HOURS, SP)).toBe(false); // domingo
	});
	it("usa o dia local, não o UTC (meia-noite)", () => {
		// 02:00 UTC de terça = 23:00 de segunda em São Paulo: dia útil, mas fora da janela.
		expect(isWithinWorkHours(new Date("2026-10-27T02:00:00Z"), DEFAULT_WORK_HOURS, SP)).toBe(false);
		// 03:00 UTC de domingo = 00:00 de domingo... e 02:59 UTC de sábado ainda é sexta 23:59.
		const friday = { start: "00:00", end: "23:59", days: [5] };
		expect(isWithinWorkHours(new Date("2026-10-31T02:30:00Z"), friday, SP)).toBe(true); // sexta 23:30 local
		expect(isWithinWorkHours(new Date("2026-10-31T03:00:00Z"), friday, SP)).toBe(false); // sábado 00:00 local
	});
	it("fuso diferente muda o resultado; fuso inválido cai em São Paulo", () => {
		const now = new Date("2026-10-26T12:00:00Z");
		expect(isWithinWorkHours(now, DEFAULT_WORK_HOURS, "Asia/Tokyo")).toBe(false); // 21:00
		expect(isWithinWorkHours(now, DEFAULT_WORK_HOURS, "Nao/Existe")).toBe(true);
		expect(isWithinWorkHours(now, DEFAULT_WORK_HOURS, undefined)).toBe(true);
	});
	it("dias personalizados incluem o sábado", () => {
		const wh = { start: "09:00", end: "13:00", days: [6] };
		expect(isWithinWorkHours(new Date("2026-10-24T15:00:00Z"), wh, SP)).toBe(true); // sáb 12:00
		expect(isWithinWorkHours(new Date("2026-10-26T15:00:00Z"), wh, SP)).toBe(false);
	});
});

describe("nextWorkDayStart", () => {
	it("antes do início num dia útil: começa hoje", () => {
		expect(iso(nextWorkDayStart(new Date("2026-10-26T09:00:00Z"), DEFAULT_WORK_HOURS, SP))).toBe("2026-10-26T11:00:00.000Z");
	});
	it("exatamente no início ou dentro do expediente: próximo dia útil", () => {
		expect(iso(nextWorkDayStart(new Date("2026-10-26T11:00:00Z"), DEFAULT_WORK_HOURS, SP))).toBe("2026-10-27T11:00:00.000Z");
		expect(iso(nextWorkDayStart(new Date("2026-10-26T15:00:00Z"), DEFAULT_WORK_HOURS, SP))).toBe("2026-10-27T11:00:00.000Z");
	});
	it("depois do fim: próximo dia útil", () => {
		expect(iso(nextWorkDayStart(new Date("2026-10-26T22:00:00Z"), DEFAULT_WORK_HOURS, SP))).toBe("2026-10-27T11:00:00.000Z");
	});
	it("sexta à noite e fim de semana pulam para segunda", () => {
		expect(iso(nextWorkDayStart(new Date("2026-10-30T22:00:00Z"), DEFAULT_WORK_HOURS, SP))).toBe("2026-11-02T11:00:00.000Z");
		expect(iso(nextWorkDayStart(new Date("2026-10-24T15:00:00Z"), DEFAULT_WORK_HOURS, SP))).toBe("2026-10-26T11:00:00.000Z");
		expect(iso(nextWorkDayStart(new Date("2026-10-25T15:00:00Z"), DEFAULT_WORK_HOURS, SP))).toBe("2026-10-26T11:00:00.000Z");
	});
	it("meia-noite local: o dia local manda, não o UTC", () => {
		// 03:00 UTC de segunda = 00:00 de segunda em SP: antes do início, começa hoje às 08:00 local.
		expect(iso(nextWorkDayStart(new Date("2026-10-26T03:00:00Z"), DEFAULT_WORK_HOURS, SP))).toBe("2026-10-26T11:00:00.000Z");
		// 02:59 UTC de segunda = 23:59 de domingo: ainda é domingo.
		expect(iso(nextWorkDayStart(new Date("2026-10-26T02:59:00Z"), DEFAULT_WORK_HOURS, SP))).toBe("2026-10-26T11:00:00.000Z");
	});
	it("outro fuso fixo (Asia/Tokyo, UTC+9)", () => {
		// segunda 10:00 UTC = 19:00 em Tóquio (fora): próximo início é terça 08:00 JST = segunda 23:00 UTC.
		expect(iso(nextWorkDayStart(new Date("2026-10-26T10:00:00Z"), DEFAULT_WORK_HOURS, "Asia/Tokyo"))).toBe("2026-10-26T23:00:00.000Z");
	});
	it("o resultado sempre cai dentro do expediente", () => {
		for (const now of ["2026-10-24T15:00:00Z", "2026-10-26T22:00:00Z", "2026-10-30T22:00:00Z"]) {
			expect(isWithinWorkHours(nextWorkDayStart(new Date(now), DEFAULT_WORK_HOURS, SP), DEFAULT_WORK_HOURS, SP)).toBe(true);
		}
	});
});

describe("parseWorkHours / readWorkHours", () => {
	it("aceita e ordena os dias", () => {
		expect(parseWorkHours({ start: "09:00", end: "17:30", days: [5, 1, 3] })).toEqual({ start: "09:00", end: "17:30", days: [1, 3, 5] });
	});
	it("rejeita formato, ordem, dias repetidos ou fora de 0-6", () => {
		for (const bad of [
			null,
			[],
			{ start: "9:00", end: "17:00", days: [1] },
			{ start: "18:00", end: "08:00", days: [1] },
			{ start: "08:00", end: "08:00", days: [1] },
			{ start: "08:00", end: "18:00", days: [] },
			{ start: "08:00", end: "18:00", days: [1, 1] },
			{ start: "08:00", end: "18:00", days: [7] },
			{ start: "08:00", end: "18:00", days: [1.5] },
			{ start: "08:00", end: "18:00" },
		]) expect(parseWorkHours(bad)).toBeNull();
	});
	it("conta antiga sem workHours usa o padrão (segunda a sexta, 08:00-18:00)", () => {
		expect(readWorkHours({})).toEqual({ start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] });
		expect(readWorkHours(undefined)).toEqual(DEFAULT_WORK_HOURS);
		expect(readWorkHours({ general: { workHours: { start: "x" } } })).toEqual(DEFAULT_WORK_HOURS);
		expect(readWorkHours({ general: { workHours: { start: "07:00", end: "12:00", days: [6] } } })).toEqual({ start: "07:00", end: "12:00", days: [6] });
	});
});
