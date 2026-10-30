import { describe, expect, it } from "vitest";
import { CURRENT_TIME_TOOL, executeCurrentTime } from "./current-time.js";

const now = new Date("2026-10-30T20:37:45Z");

describe("current_time", () => {
	it("devolve data, hora, dia da semana e ISO no fuso da conta, com `now` injetado", () => {
		expect(executeCurrentTime({}, { now, timeZone: "America/Sao_Paulo" }).summary).toBe(
			"2026-10-30 17:37 (sexta-feira), timezone America/Sao_Paulo. ISO: 2026-10-30T17:37:45-03:00",
		);
	});

	it("sem fuso na conta cai em São Paulo; fuso do argumento vale para a chamada", () => {
		expect(executeCurrentTime({}, { now }).summary).toContain("timezone America/Sao_Paulo");
		expect(executeCurrentTime({ timezone: "Asia/Tokyo" }, { now, timeZone: "America/Sao_Paulo" }).summary).toBe(
			"2026-10-31 05:37 (sábado), timezone Asia/Tokyo. ISO: 2026-10-31T05:37:45+09:00",
		);
		expect(executeCurrentTime({ timezone: "UTC" }, { now }).summary).toContain("ISO: 2026-10-30T20:37:45+00:00");
	});

	it("fuso inválido falha com dica acionável (ok:false no runtime)", () => {
		expect(() => executeCurrentTime({ timezone: "Mars/Olympus" }, { now })).toThrow(/Invalid timezone "Mars\/Olympus".*America\/Sao_Paulo/);
		expect(() => executeCurrentTime({ timezone: 42 }, { now })).toThrow(/Invalid timezone/);
	});

	it("o schema é minúsculo (grupo lazy): menos de 450 caracteres", () => {
		expect(JSON.stringify(CURRENT_TIME_TOOL).length).toBeLessThan(450);
	});
});
