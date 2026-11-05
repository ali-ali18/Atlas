import { describe, expect, it } from "vitest";
import { filterTimeZones, isAutoTimezone, timeZoneCity, timeZoneLabel, timezoneToSync, withExtras } from "./timezone";

const ZONES = ["America/Sao_Paulo", "America/Argentina/Buenos_Aires", "Europe/Lisbon", "UTC"];

describe("nomes", () => {
	it("cidade com acento", () => {
		expect(timeZoneCity("America/Sao_Paulo")).toBe("São Paulo");
		expect(timeZoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
		expect(timeZoneCity("UTC")).toBe("UTC");
	});
	it("rótulo com deslocamento em data fixa", () => {
		expect(timeZoneLabel("America/Sao_Paulo", new Date("2026-06-01T12:00:00Z"))).toMatch(/^São Paulo/);
		expect(timeZoneLabel("Nao/Existe", new Date("2026-06-01T12:00:00Z"))).toBe("Existe");
	});
});

describe("filterTimeZones", () => {
	it("sem busca devolve tudo", () => {
		expect(filterTimeZones(ZONES, "  ")).toEqual(ZONES);
	});
	it("ignora acento, caixa e separadores", () => {
		expect(filterTimeZones(ZONES, "sao paulo")).toEqual(["America/Sao_Paulo"]);
		expect(filterTimeZones(ZONES, "SÃO")).toEqual(["America/Sao_Paulo"]);
		expect(filterTimeZones(ZONES, "buenos")).toEqual(["America/Argentina/Buenos_Aires"]);
		expect(filterTimeZones(ZONES, "america")).toHaveLength(2);
		expect(filterTimeZones(ZONES, "zzz")).toEqual([]);
	});
});

describe("withExtras", () => {
	it("acrescenta UTC e os fusos válidos, sem repetir e em ordem", () => {
		expect(withExtras(["Europe/Lisbon"], "America/Sao_Paulo", "Europe/Lisbon", null, "Lixo")).toEqual(["America/Sao_Paulo", "Europe/Lisbon", "UTC"]);
	});
});

describe("fuso automático", () => {
	it("escolha explícita vence a inferência", () => {
		expect(isAutoTimezone(false, null, "America/Sao_Paulo")).toBe(false);
		expect(isAutoTimezone(true, "Europe/Lisbon", "America/Sao_Paulo")).toBe(true);
	});
	it("sem escolha: conta sem fuso ou igual ao do aparelho segue o aparelho; outro fuso escolhido à mão não", () => {
		expect(isAutoTimezone(null, null, "America/Sao_Paulo")).toBe(true);
		expect(isAutoTimezone(null, "America/Sao_Paulo", "America/Sao_Paulo")).toBe(true);
		expect(isAutoTimezone(null, "Europe/Lisbon", "America/Sao_Paulo")).toBe(false);
	});
	it("timezoneToSync só grava quando automático e diferente", () => {
		expect(timezoneToSync(true, null, "America/Manaus")).toBe("America/Manaus");
		expect(timezoneToSync(true, "America/Sao_Paulo", "America/Manaus")).toBe("America/Manaus");
		expect(timezoneToSync(true, "America/Manaus", "America/Manaus")).toBeNull();
		expect(timezoneToSync(false, null, "America/Manaus")).toBeNull();
		expect(timezoneToSync(true, null, null)).toBeNull();
		expect(timezoneToSync(true, null, "Lixo")).toBeNull();
	});
});
