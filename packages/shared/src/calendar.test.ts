import { describe, expect, it } from "vitest";
import {
	findCalendarConflicts,
	formatCalendarWhen,
	mergeCalendarEventPatch,
	normalizeCalendarEventInput,
	parseCalendarCard,
	parseCalendarMoment,
	parseConversationCard,
	resolveCalendarRange,
	serializeConversationCard,
	toCalendarCardEvent,
	type CalendarEventView,
} from "./index.js";

const SP = "America/Sao_Paulo";
// Terça 2026-11-10, 09:00 em São Paulo.
const NOW = new Date("2026-11-10T12:00:00.000Z");
const ev = (over: Partial<CalendarEventView> & { id: string }): CalendarEventView => ({ title: "Reunião", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T18:00:00.000Z", allDay: false, ...over });

describe("parseCalendarMoment", () => {
	it("data = dia inteiro; ISO com fuso vale o instante; ISO sem fuso vale o fuso do dono", () => {
		expect(parseCalendarMoment("2026-11-10", "start", SP)).toEqual({ ok: true, kind: "date", date: "2026-11-10" });
		expect(parseCalendarMoment("2026-11-10T14:00-03:00", "start", SP)).toEqual({ ok: true, kind: "instant", iso: "2026-11-10T17:00:00.000Z" });
		expect(parseCalendarMoment("2026-11-10T14:00", "start", SP)).toEqual({ ok: true, kind: "instant", iso: "2026-11-10T17:00:00.000Z" });
		expect(parseCalendarMoment("2026-11-10 14:00", "start", "America/New_York")).toEqual({ ok: true, kind: "instant", iso: "2026-11-10T19:00:00.000Z" });
	});
	it("recusa texto livre, data impossível e hora impossível, dizendo o formato", () => {
		for (const bad of ["amanhã 14h", "2026-02-31", "2026-11-10T25:00", "", 5]) {
			const r = parseCalendarMoment(bad, "start", SP);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/start/);
		}
	});
});

describe("normalizeCalendarEventInput", () => {
	it("evento com hora: duração padrão de 1 h, convidados normalizados sem repetir", () => {
		const r = normalizeCalendarEventInput({ title: " Dentista ", start: "2026-11-11T15:00", attendees: ["A@x.com", "a@x.com", "b@y.org"] }, SP);
		expect(r).toEqual({ ok: true, value: { title: "Dentista", start: "2026-11-11T18:00:00.000Z", end: "2026-11-11T19:00:00.000Z", allDay: false, attendees: ["a@x.com", "b@y.org"] } });
	});
	it("durationMinutes, end e dia inteiro", () => {
		expect(normalizeCalendarEventInput({ title: "x", start: "2026-11-11T15:00", durationMinutes: 30 }, SP)).toMatchObject({ ok: true, value: { end: "2026-11-11T18:30:00.000Z" } });
		expect(normalizeCalendarEventInput({ title: "Feriado", start: "2026-11-15" }, SP)).toMatchObject({ ok: true, value: { allDay: true, start: "2026-11-15", end: "2026-11-16" } });
		expect(normalizeCalendarEventInput({ title: "Viagem", start: "2026-11-15", end: "2026-11-18" }, SP)).toMatchObject({ ok: true, value: { allDay: true, end: "2026-11-18" } });
	});
	it("recusa: sem título, fim antes do início, end junto de duration, misturar dia e hora, convidado inválido, evento enorme", () => {
		const err = (raw: Record<string, unknown>) => { const r = normalizeCalendarEventInput({ title: "x", start: "2026-11-11T15:00", ...raw }, SP); return r.ok ? "ok" : r.error; };
		expect(err({ title: " " })).toMatch(/title/);
		expect(err({ end: "2026-11-11T14:00" })).toMatch(/end must be after start/);
		expect(err({ end: "2026-11-11T16:00", durationMinutes: 30 })).toMatch(/not both/);
		expect(err({ end: "2026-11-12" })).toMatch(/both be dates/);
		expect(err({ attendees: ["sem-arroba"] })).toMatch(/not an email/);
		expect(err({ attendees: ["a@b.com"].concat(Array.from({ length: 25 }, (_, i) => `p${i}@x.com`)) })).toMatch(/limit is 20/);
		expect(err({ durationMinutes: 0 })).toMatch(/durationMinutes/);
		expect(err({ end: "2026-12-30T15:00" })).toMatch(/7 days/);
	});
});

describe("mergeCalendarEventPatch", () => {
	const existing = ev({ id: "e1", title: "Reunião", location: "Sala 2", attendees: ["a@x.com"] });
	it("mudar só o início mantém a duração", () => {
		const r = mergeCalendarEventPatch(existing, { start: "2026-11-10T16:00" }, SP);
		expect(r).toMatchObject({ ok: true, changed: ["time"], value: { start: "2026-11-10T19:00:00.000Z", end: "2026-11-10T20:00:00.000Z", location: "Sala 2", attendees: ["a@x.com"] } });
	});
	it("local vazio apaga; convidados substituem a lista; sem campo nenhum é recusado", () => {
		const r = mergeCalendarEventPatch(existing, { location: "", attendees: [] }, SP);
		expect(r).toMatchObject({ ok: true, changed: ["location", "attendees"] });
		expect(r.ok && r.value.location).toBeUndefined();
		expect(r.ok && r.value.attendees).toEqual([]);
		expect(mergeCalendarEventPatch(existing, {}, SP)).toMatchObject({ ok: false, error: expect.stringContaining("Nothing to change") });
	});
	it("durationMinutes recalcula o fim; fim antes do início é recusado; dia inteiro mantém os dias", () => {
		expect(mergeCalendarEventPatch(existing, { durationMinutes: 90 }, SP)).toMatchObject({ ok: true, value: { end: "2026-11-10T18:30:00.000Z" } });
		expect(mergeCalendarEventPatch(existing, { end: "2026-11-10T13:00" }, SP)).toMatchObject({ ok: false });
		const allDay = ev({ id: "e2", allDay: true, start: "2026-11-15", end: "2026-11-17" });
		expect(mergeCalendarEventPatch(allDay, { start: "2026-11-20" }, SP)).toMatchObject({ ok: true, value: { start: "2026-11-20", end: "2026-11-22" } });
		expect(mergeCalendarEventPatch(allDay, { start: "2026-11-20T10:00" }, SP)).toMatchObject({ ok: false, error: expect.stringContaining("end as well") });
	});
});

describe("findCalendarConflicts: por horário, sem texto", () => {
	const events = [
		ev({ id: "a", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T18:00:00.000Z" }),
		ev({ id: "b", start: "2026-11-10T18:00:00.000Z", end: "2026-11-10T19:00:00.000Z" }),
		ev({ id: "livre", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T19:00:00.000Z", free: true }),
		ev({ id: "cancelado", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T19:00:00.000Z", cancelled: true }),
		ev({ id: "recusado", start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T19:00:00.000Z", selfResponse: "declined" }),
		ev({ id: "feriado", allDay: true, start: "2026-11-10", end: "2026-11-11" }),
	];
	it("sobreposição de verdade conta; encostar na ponta não; livre, cancelado, recusado e dia inteiro não bloqueiam", () => {
		expect(findCalendarConflicts(events, { start: "2026-11-10T17:30:00.000Z", end: "2026-11-10T18:30:00.000Z", allDay: false }).map((e) => e.id)).toEqual(["a", "b"]);
		expect(findCalendarConflicts(events, { start: "2026-11-10T19:00:00.000Z", end: "2026-11-10T20:00:00.000Z", allDay: false })).toEqual([]);
		expect(findCalendarConflicts(events, { start: "2026-11-10T16:00:00.000Z", end: "2026-11-10T17:00:00.000Z", allDay: false })).toEqual([]);
	});
	it("ao alterar, o próprio evento não conflita consigo mesmo; candidato de dia inteiro nunca conflita", () => {
		expect(findCalendarConflicts(events, { start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T18:00:00.000Z", allDay: false, ignoreId: "a" }).map((e) => e.id)).toEqual([]);
		expect(findCalendarConflicts(events, { start: "2026-11-10", end: "2026-11-11", allDay: true })).toEqual([]);
	});
});

describe("resolveCalendarRange", () => {
	it("padrão = hoje no fuso do dono", () => {
		expect(resolveCalendarRange({ now: NOW, timeZone: SP })).toEqual({ ok: true, from: "2026-11-10T03:00:00.000Z", to: "2026-11-11T03:00:00.000Z" });
	});
	it("um dia, um período (to é o último dia incluído) e os limites", () => {
		expect(resolveCalendarRange({ date: "2026-11-12", now: NOW, timeZone: SP })).toEqual({ ok: true, from: "2026-11-12T03:00:00.000Z", to: "2026-11-13T03:00:00.000Z" });
		expect(resolveCalendarRange({ from: "2026-11-10", to: "2026-11-12", now: NOW, timeZone: SP })).toEqual({ ok: true, from: "2026-11-10T03:00:00.000Z", to: "2026-11-13T03:00:00.000Z" });
		expect(resolveCalendarRange({ date: "2026-11-12", from: "2026-11-10", now: NOW, timeZone: SP })).toMatchObject({ ok: false });
		expect(resolveCalendarRange({ from: "2026-11-12", to: "2026-11-10", now: NOW, timeZone: SP })).toMatchObject({ ok: false, error: expect.stringContaining("before") });
		expect(resolveCalendarRange({ from: "2026-11-01", to: "2026-12-31", now: NOW, timeZone: SP })).toMatchObject({ ok: false, error: expect.stringContaining("limit is 31") });
		expect(resolveCalendarRange({ date: "amanhã", now: NOW, timeZone: SP })).toMatchObject({ ok: false });
	});
});

describe("formatCalendarWhen", () => {
	it("no fuso do dono", () => {
		expect(formatCalendarWhen(ev({ id: "x" }), SP)).toBe("2026-11-10 14:00–15:00");
		expect(formatCalendarWhen(ev({ id: "x", end: "2026-11-11T18:00:00.000Z" }), SP)).toBe("2026-11-10 14:00 to 2026-11-11 15:00");
		expect(formatCalendarWhen(ev({ id: "x", allDay: true, start: "2026-11-15", end: "2026-11-16" }), SP)).toBe("2026-11-15 (all day)");
		expect(formatCalendarWhen(ev({ id: "x", allDay: true, start: "2026-11-15", end: "2026-11-18" }), SP)).toBe("2026-11-15 to 2026-11-17 (all day)");
	});
});

describe("cartão calendar persistido", () => {
	const card = { v: 1, kind: "calendar", cardId: "cal:run-1:e1", runId: "run-1", action: "created", timeZone: SP, events: [toCalendarCardEvent(ev({ id: "e1", location: "Sala 2", attendees: ["a@x.com", "b@x.com"], link: "https://www.google.com/calendar/event?eid=1", description: "NÃO VAI NO CARD" }), true)], notified: true };
	it("vai e volta pelo serializador da conversa, sem a descrição nem os e-mails dos convidados", () => {
		const parsed = parseConversationCard(serializeConversationCard(card as never));
		expect(parsed).toMatchObject({ kind: "calendar", cardId: "cal:run-1:e1", action: "created", notified: true, events: [{ id: "e1", conflict: true, attendeeCount: 2, location: "Sala 2" }] });
		expect(JSON.stringify(parsed)).not.toContain("NÃO VAI NO CARD");
		expect(JSON.stringify(parsed)).not.toContain("a@x.com");
	});
	it("recusa lixo: fuso falso, ação desconhecida, evento sem hora válida, link que não é https, criado sem eventos", () => {
		expect(parseCalendarCard({ ...card, timeZone: "Marte/Olimpo" })).toBeNull();
		expect(parseCalendarCard({ ...card, action: "deleted" })).toBeNull();
		expect(parseCalendarCard({ ...card, events: [{ ...card.events[0], start: "ontem" }] })).toBeNull();
		expect(parseCalendarCard({ ...card, events: [] })).toBeNull();
		expect(parseCalendarCard({ ...card, events: [{ ...card.events[0], link: "javascript:alert(1)" }] })?.events[0]?.link).toBeUndefined();
	});
	it("lista de um dia vazio é válida (o cartão diz que o dia está livre)", () => {
		expect(parseCalendarCard({ v: 1, kind: "calendar", cardId: "cal:run-2", action: "listed", timeZone: SP, events: [] })).toMatchObject({ action: "listed", events: [] });
	});
});
