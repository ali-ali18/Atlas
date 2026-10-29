import assert from "node:assert/strict";
import test from "node:test";
import { formatListTime, rowTime } from "./list-time";

const SP = "America/Sao_Paulo"; // UTC-3, sem horário de verão
const at = (iso: string) => new Date(iso);
// 15/10/2026 (quinta) 15:30 em São Paulo = 18:30Z
const NOW = at("2026-10-15T18:30:00Z");

test("menos de 1 minuto: agora", () => {
	assert.equal(formatListTime("2026-10-15T18:29:30Z", NOW, SP), "agora");
	assert.equal(formatListTime("2026-10-15T18:30:00Z", NOW, SP), "agora");
	assert.equal(formatListTime("2026-10-15T18:29:00Z", NOW, SP), "15:29");
});

test("mesmo dia: HH:mm", () => {
	assert.equal(formatListTime("2026-10-15T12:05:00Z", NOW, SP), "09:05");
	assert.equal(formatListTime("2026-10-15T03:00:00Z", NOW, SP), "00:00");
});

test("ontem, inclusive atravessando a meia-noite", () => {
	assert.equal(formatListTime("2026-10-14T18:30:00Z", NOW, SP), "Ontem");
	const justAfterMidnight = at("2026-10-15T03:01:00Z"); // 00:01 local
	assert.equal(formatListTime("2026-10-15T02:59:00Z", justAfterMidnight, SP), "Ontem"); // 23:59 local
	assert.equal(formatListTime("2026-10-15T03:00:30Z", justAfterMidnight, SP), "agora");
});

test("fuso: UTC já é dia seguinte, local ainda não", () => {
	const now = at("2026-10-16T01:30:00Z"); // 15/10 22:30 em SP
	assert.equal(formatListTime("2026-10-15T23:00:00Z", now, SP), "20:00");
	assert.equal(formatListTime("2026-10-15T23:00:00Z", now, "UTC"), "Ontem");
});

test("últimos 6 dias: dia da semana abreviado", () => {
	assert.equal(formatListTime("2026-10-13T18:00:00Z", NOW, SP), "Ter");
	assert.equal(formatListTime("2026-10-12T18:00:00Z", NOW, SP), "Seg");
	assert.equal(formatListTime("2026-10-09T18:00:00Z", NOW, SP), "Sex");
	assert.equal(formatListTime("2026-10-10T18:00:00Z", NOW, SP), "Sáb");
	assert.equal(formatListTime("2026-10-11T18:00:00Z", NOW, SP), "Dom");
});

test("mais antigo: dd/MM/yy", () => {
	assert.equal(formatListTime("2026-10-08T18:00:00Z", NOW, SP), "08/10/26");
	assert.equal(formatListTime("2026-01-02T18:00:00Z", NOW, SP), "02/01/26");
	assert.equal(formatListTime("2025-12-31T18:00:00Z", NOW, SP), "31/12/25");
});

test("sem data ou inválida: vazio", () => {
	assert.equal(formatListTime(null, NOW, SP), "");
	assert.equal(formatListTime(undefined, NOW, SP), "");
	assert.equal(formatListTime("", NOW, SP), "");
	assert.equal(formatListTime("nada", NOW, SP), "");
});

test("data levemente no futuro (relógio adiantado) não quebra", () => {
	assert.equal(formatListTime("2026-10-15T18:30:20Z", NOW, SP), "agora");
	assert.equal(formatListTime("2026-10-15T19:30:00Z", NOW, SP), "16:30");
});

test("rowTime: sem campo usa o texto pronto; com campo formata", () => {
	assert.equal(rowTime({ time: "09:09" }, NOW.getTime()), "09:09");
	assert.equal(rowTime({ time: "", lastMessageAt: null }, NOW.getTime()), "");
	assert.equal(rowTime({ time: "", lastMessageAt: "2026-10-14T18:30:00Z" }, NOW.getTime()), "Ontem");
});

test("idioma da interface: en-US e es-ES usam as palavras e o formato do Intl", () => {
	assert.equal(formatListTime("2026-10-15T18:29:30Z", NOW, SP, "en-US"), "now");
	assert.match(formatListTime("2026-10-15T12:05:00Z", NOW, SP, "en-US"), /^9:05\sAM$/);
	assert.equal(formatListTime("2026-10-14T18:30:00Z", NOW, SP, "en-US"), "Yesterday");
	assert.equal(formatListTime("2026-10-13T18:00:00Z", NOW, SP, "en-US"), "Tue");
	assert.equal(formatListTime("2026-10-08T18:00:00Z", NOW, SP, "en-US"), "10/08/26");
	assert.equal(formatListTime("2026-10-14T18:30:00Z", NOW, SP, "es-ES"), "Ayer");
	assert.equal(formatListTime("2026-10-12T18:00:00Z", NOW, SP, "es-ES"), "Lun");
	assert.equal(formatListTime("2026-10-15T12:05:00Z", NOW, SP, "es-ES"), "09:05");
});
