import assert from "node:assert/strict"
import test from "node:test"
import {
	compareText,
	foldSearch,
	formatCompactNumber,
	formatCurrency,
	formatDate,
	formatDateTime,
	formatList,
	formatNumber,
	formatPercent,
	formatRelative,
	formatTime,
	formatWeekday,
	toDate,
} from "./format"

const WHEN = new Date("2026-10-03T14:05:00Z")
const UTC = { timeZone: "UTC" }

test("formatDate segue a ordem do idioma", () => {
	assert.equal(formatDate(WHEN, "pt-BR", { ...UTC, day: "2-digit", month: "2-digit", year: "numeric" }), "03/10/2026")
	assert.equal(formatDate(WHEN, "en-US", { ...UTC, day: "2-digit", month: "2-digit", year: "numeric" }), "10/03/2026")
	assert.equal(formatDate(WHEN, "es-ES", { ...UTC, day: "2-digit", month: "2-digit", year: "numeric" }), "03/10/2026")
	assert.equal(formatDate("2026-10-03T14:05:00Z", "en-US", { ...UTC, month: "long", day: "numeric" }), "October 3")
})

test("formatTime: en usa AM/PM, pt e es usam 24 h; h23 força 24 h", () => {
	assert.equal(formatTime(WHEN, "pt-BR", UTC), "14:05")
	assert.equal(formatTime(WHEN, "es-ES", UTC), "14:05")
	assert.match(formatTime(WHEN, "en-US", UTC), /^0?2:05\s?PM$/)
	assert.equal(formatTime(WHEN, "en-US", { ...UTC, hourCycle: "h23" }), "14:05")
})

test("formatDateTime e formatWeekday", () => {
	assert.match(formatDateTime(WHEN, "pt-BR", UTC), /^03\/10,? 14:05$/)
	assert.match(formatWeekday(WHEN, "pt-BR", UTC), /^sáb/)
	assert.equal(formatWeekday(WHEN, "en-US", UTC), "Sat")
	assert.match(formatWeekday(WHEN, "es-ES", UTC), /^sáb/)
})

test("entradas vazias ou inválidas devolvem texto vazio, sem lançar", () => {
	assert.equal(formatDate(null), "")
	assert.equal(formatDate(undefined, "en-US"), "")
	assert.equal(formatDate("não é data", "en-US"), "")
	assert.equal(formatTime(""), "")
	assert.equal(formatNumber(Number.NaN), "")
	assert.equal(formatNumber(Number.POSITIVE_INFINITY), "")
	assert.equal(toDate(0)?.getTime(), 0)
})

test("formatNumber, compacto, percentual e moeda", () => {
	assert.equal(formatNumber(1234.5, "pt-BR"), "1.234,5")
	assert.equal(formatNumber(1234.5, "en-US"), "1,234.5")
	assert.equal(formatNumber(1234.5, "es-ES"), "1234,5")
	assert.equal(formatNumber(12345, "es-ES"), "12.345")
	assert.equal(formatCompactNumber(1500, "en-US"), "1.5K")
	assert.match(formatCompactNumber(1500, "pt-BR"), /^1,5\smil$/)
	assert.equal(formatPercent(0.256, "pt-BR", 1).replace(/\s/g, ""), "25,6%")
	assert.equal(formatPercent(0.5, "en-US"), "50%")
	assert.equal(formatCurrency(1234.5, "BRL", "pt-BR").replace(/\s/g, " "), "R$ 1.234,50")
	assert.equal(formatCurrency(1234.5, "USD", "en-US"), "$1,234.50")
})

test("formatRelative com now injetado", () => {
	const now = new Date("2026-10-03T14:05:00Z")
	assert.equal(formatRelative(new Date(now.getTime() - 5 * 60_000), now, "pt-BR"), "há 5 minutos")
	assert.equal(formatRelative(new Date(now.getTime() - 5 * 60_000), now, "en-US"), "5 minutes ago")
	assert.equal(formatRelative(new Date(now.getTime() - 5 * 60_000), now, "es-ES"), "hace 5 minutos")
	assert.equal(formatRelative(new Date(now.getTime() - 86_400_000), now, "en-US"), "yesterday")
	assert.equal(formatRelative(new Date(now.getTime() + 3 * 3_600_000), now, "en-US"), "in 3 hours")
	assert.equal(formatRelative(new Date(now.getTime() - 10_000), now, "en-US"), "now")
	assert.equal(formatRelative("lixo", now, "en-US"), "")
})

test("formatList, compareText e foldSearch", () => {
	assert.equal(formatList(["a", "b", "c"], "pt-BR"), "a, b e c")
	assert.equal(formatList(["a", "b", "c"], "en-US"), "a, b, and c")
	assert.equal(formatList(["a", "b", "c"], "es-ES", "disjunction"), "a, b o c")
	assert.ok(compareText("árvore", "bola", "pt-BR") < 0)
	assert.equal(foldSearch("Ação ÁRVORE"), "acao arvore")
})
