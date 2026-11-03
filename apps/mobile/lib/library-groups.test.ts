import { describe, expect, it } from "vitest";
import { formatLibraryAge, groupLibraryItems, libraryRowSubtitle } from "./library-groups";
import type { LibraryItem } from "./library-items";

// Datas montadas no fuso local (como o código lê): os testes valem em qualquer TZ.
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
const NOW = at(2026, 11, 2, 15); // segunda, 02/11/2026 15:00
const item = (key: string, date: Date | string): LibraryItem => ({ key, source: "file", id: key, kind: "document", title: key, date: typeof date === "string" ? date : date.toISOString() });
const labels = (items: LibraryItem[]) => groupLibraryItems(items, NOW).map((group) => `${group.label}:${group.items.map((entry) => entry.key).join(",")}`);

describe("groupLibraryItems", () => {
	it("Hoje, ontem vira Esta semana, 6 dias atrás ainda é semana, 7 dias vira o mês", () => {
		expect(labels([item("hoje", at(2026, 11, 2, 9)), item("ontem", at(2026, 11, 1, 22)), item("seis", at(2026, 10, 27, 8)), item("sete", at(2026, 10, 26, 23))])).toEqual(["Hoje:hoje", "Esta semana:ontem,seis", "Outubro:sete"]);
	});
	it("fuso: 23:30 de ontem não é Hoje mesmo faltando minutos", () => {
		const now = at(2026, 11, 2, 0, 10);
		const groups = groupLibraryItems([item("a", at(2026, 11, 1, 23, 30))], now);
		expect(groups.map((group) => group.label)).toEqual(["Esta semana"]);
	});
	it("meses anteriores ficam em grupos separados na ordem; ano diferente leva o ano", () => {
		expect(labels([item("a", at(2026, 10, 10)), item("b", at(2026, 10, 1)), item("c", at(2026, 9, 30)), item("d", at(2025, 12, 31))])).toEqual(["Outubro:a,b", "Setembro:c", "Dezembro de 2025:d"]);
	});
	it("mesmo mês do ano anterior não se mistura com o do ano corrente", () => {
		expect(labels([item("a", at(2026, 10, 10)), item("b", at(2025, 10, 10))])).toEqual(["Outubro:a", "Outubro de 2025:b"]);
	});
	it("data futura entra em Hoje; data inválida vai para 'Sem data' no fim", () => {
		expect(labels([item("fut", at(2026, 11, 5)), item("hoje", at(2026, 11, 2, 1)), item("ruim", "lixo")])).toEqual(["Hoje:fut,hoje", "Sem data:ruim"]);
	});
	it("lista vazia não gera grupo", () => {
		expect(groupLibraryItems([], NOW)).toEqual([]);
	});
});

describe("formatLibraryAge", () => {
	const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
	const MIN = 60_000;
	const H = 60 * MIN;
	const D = 24 * H;
	it("escala curta", () => {
		expect(formatLibraryAge(ago(10_000), NOW)).toBe("agora");
		expect(formatLibraryAge(ago(5 * MIN), NOW)).toBe("5 min");
		expect(formatLibraryAge(ago(59 * MIN), NOW)).toBe("59 min");
		expect(formatLibraryAge(ago(2 * H), NOW)).toBe("2h");
		expect(formatLibraryAge(ago(23 * H), NOW)).toBe("23h");
		expect(formatLibraryAge(ago(25 * H), NOW)).toBe("1 d");
		expect(formatLibraryAge(ago(6 * D), NOW)).toBe("6 d");
		expect(formatLibraryAge(ago(21 * D), NOW)).toBe("3 sem");
		expect(formatLibraryAge(ago(45 * D), NOW)).toBe("1 mês");
		expect(formatLibraryAge(ago(90 * D), NOW)).toBe("3 meses");
		expect(formatLibraryAge(ago(400 * D), NOW)).toBe("1 ano");
		expect(formatLibraryAge(ago(800 * D), NOW)).toBe("2 anos");
	});
	it("futuro vira 'agora'; inválida vira vazio", () => {
		expect(formatLibraryAge(ago(-5 * H), NOW)).toBe("agora");
		expect(formatLibraryAge("lixo", NOW)).toBe("");
	});
	it("subtítulo da linha", () => {
		const panel: LibraryItem = { ...item("p", ago(2 * H)), kind: "panel" };
		expect(libraryRowSubtitle(panel, NOW)).toBe("Painel · 2h");
		expect(libraryRowSubtitle(item("x", ago(25 * H)), NOW)).toBe("Documento · 1 d");
		expect(libraryRowSubtitle(item("y", "lixo"), NOW)).toBe("Documento");
	});
});
