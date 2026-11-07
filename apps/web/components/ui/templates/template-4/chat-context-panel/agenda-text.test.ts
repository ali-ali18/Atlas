import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgendaItemView } from "@workspace/shared";
import { loadMessages } from "@/lib/i18n/messages";
import { createTranslator } from "@/lib/i18n/translator";
import { agendaCardModel, agendaEndText, agendaSummary, applyAgendaChange } from "./agenda-text";

const TZ = "America/Sao_Paulo";
// 07/11/2026 09:00 em São Paulo.
const NOW = new Date("2026-11-07T12:00:00.000Z");

const item = (patch: Partial<AgendaItemView> = {}): AgendaItemView => ({
	id: "i1",
	botId: "b1",
	kind: "remind",
	status: "pending",
	note: "Ligar para a Dra. Paula",
	nextAt: "2026-11-08T13:00:00.000Z",
	intervalMinutes: null,
	untilAt: null,
	event: null,
	endReason: null,
	runCount: 0,
	maxRuns: null,
	lastUpdate: null,
	createdAt: "2026-11-07T11:00:00.000Z",
	...patch,
});

test("lembrete de uma vez: hoje, amanhã e outra data, no fuso do dono", () => {
	assert.equal(agendaSummary(item({ nextAt: "2026-11-07T17:30:00.000Z" }), TZ, NOW), "Hoje às 14:30");
	assert.equal(agendaSummary(item(), TZ, NOW), "Amanhã às 10:00");
	assert.equal(agendaSummary(item({ nextAt: "2026-11-12T13:00:00.000Z" }), TZ, NOW), "12/11 às 10:00");
});

test("a virada de dia usa o fuso do dono, não o UTC", () => {
	// 08/11 01:30 UTC ainda é 07/11 22:30 em São Paulo: hoje.
	assert.equal(agendaSummary(item({ nextAt: "2026-11-08T01:30:00.000Z" }), TZ, NOW), "Hoje às 22:30");
});

test("acompanhamento: 'A cada 2 h até 20/11' e sem prazo", () => {
	const watch = item({ kind: "watch", intervalMinutes: 120, untilAt: "2026-11-20T15:00:00.000Z" });
	assert.equal(agendaSummary(watch, TZ, NOW), "A cada 2 h até 20/11");
	assert.equal(agendaSummary({ ...watch, untilAt: null }, TZ, NOW), "A cada 2 h");
	assert.equal(agendaSummary({ ...watch, intervalMinutes: 90 }, TZ, NOW), "A cada 90 min até 20/11");
});

test("espera por e-mail: remetente, assunto e anexo; a vigência vai na linha seguinte", () => {
	const intent = item({ kind: "intent", nextAt: null, untilAt: "2026-12-01T15:00:00.000Z", event: { from: "loja@exemplo.com" } });
	assert.equal(agendaSummary(intent, TZ, NOW), "Quando chegar e-mail de loja@exemplo.com");
	assert.equal(agendaSummary({ ...intent, event: { subjectContains: "NF", hasAttachment: true } }, TZ, NOW), "Quando chegar e-mail com 'NF' no assunto, com anexo");
	assert.equal(agendaCardModel(intent, TZ, NOW).next, "Vale até 01/12");
});

test("estado e próxima conferência: ativo, pausado e encerrado com o motivo", () => {
	const watch = item({ kind: "watch", intervalMinutes: 120, nextAt: "2026-11-07T14:00:00.000Z" });
	const active = agendaCardModel(watch, TZ, NOW);
	assert.deepEqual([active.state, active.stateLabel, active.next], ["active", "Ativo", "Próxima conferência: Hoje às 11:00"]);
	const paused = agendaCardModel({ ...watch, status: "paused" }, TZ, NOW);
	assert.deepEqual([paused.state, paused.stateLabel, paused.next], ["paused", "Pausado", "Pausado: não confiro até você retomar"]);
	const ended = agendaCardModel(item({ status: "done", nextAt: null, endReason: "max_runs" }), TZ, NOW);
	assert.deepEqual([ended.state, ended.stateLabel, ended.endText, ended.summary, ended.next], ["ended", "Encerrado", "Parei: cheguei ao número de conferências combinado", null, null]);
});

test("motivos de fim em frase simples e sem termo interno", () => {
	for (const reason of ["owner", "completed", "done", "expired", "max_runs", "ignored_notices", "no_result", "unavailable", "reminder_note", "other", null] as const) {
		const text = agendaEndText(reason);
		assert.ok(text.length > 4, String(reason));
		assert.doesNotMatch(text, /max_runs|ignored|no_result|watch|intent|agenda_/i, `termo interno em ${reason}`);
	}
});

test("tipos aparecem em palavras, nunca como nome interno", () => {
	const kinds = (["remind", "watch", "intent", "brief"] as const).map((kind) => agendaCardModel(item({ kind }), TZ, NOW).kind);
	assert.deepEqual(kinds, ["Lembrete", "Acompanhando", "Esperando e-mail", "Resumo"]);
});

test("última novidade e 'conferi sem novidades'", () => {
	const news = agendaCardModel(item({ lastUpdate: { outcome: "update", at: "2026-11-07T10:00:00.000Z", message: "Chegou a fatura de novembro." } }), TZ, NOW);
	assert.equal(news.last, "Novidade há 2 h: Chegou a fatura de novembro.");
	const quiet = agendaCardModel(item({ lastUpdate: { outcome: "no_change", at: "2026-11-07T11:30:00.000Z", message: null } }), TZ, NOW);
	assert.equal(quiet.last, "Conferi há 30 min, sem novidades");
	assert.equal(agendaCardModel(item(), TZ, NOW).last, null);
});

test("outros idiomas: en-US e es-ES", async () => {
	const en = createTranslator("en-US", await loadMessages("en-US"));
	const es = createTranslator("es-ES", await loadMessages("es-ES"));
	assert.equal(agendaCardModel(item(), TZ, NOW, en).summary, "Tomorrow at 10:00 AM");
	assert.equal(agendaCardModel(item(), TZ, NOW, es).summary, "Mañana a las 10:00");
});

test("aplicar mudança: pausar troca no lugar; cancelar leva para o topo dos encerrados", () => {
	const a = item({ id: "a" });
	const b = item({ id: "b" });
	const old = item({ id: "old", status: "done", endReason: "completed", nextAt: null });
	const data = { items: [a, b], ended: [old] };
	const paused = applyAgendaChange(data, { ...a, status: "paused" });
	assert.deepEqual(paused.items.map((i) => [i.id, i.status]), [["a", "paused"], ["b", "pending"]]);
	const cancelled = applyAgendaChange(data, { ...a, status: "cancelled", endReason: "owner", nextAt: null });
	assert.deepEqual(cancelled.items.map((i) => i.id), ["b"]);
	assert.deepEqual(cancelled.ended.map((i) => i.id), ["a", "old"]);
});
