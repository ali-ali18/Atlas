import { describe, expect, it } from "vitest";
import { AGENDA_BRIEF_IGNORED_NOTICE_LIMIT, AGENDA_BRIEF_INTERVAL_MINUTES, AGENDA_IGNORED_NOTICE_LIMIT, nextBriefOccurrence, planAgendaItem, planAgendaWake, settleAgendaRun, settleAgendaRunWithoutResult } from "./agenda.js";
import { DEFAULT_PROACTIVE_SETTINGS, localParts, type ProactiveSettings } from "./proactive.js";

const SP: ProactiveSettings = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone: "America/Sao_Paulo" };
// Quarta 2026-11-04, 10:00 em São Paulo (UTC-3).
const NOW = new Date("2026-11-04T13:00:00.000Z");
const hhmm = (date: Date, tz: string) => {
	const p = localParts(date, tz);
	return `${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

describe("planAgendaItem: brief (plano do dia)", () => {
	it("todo dia no horário pedido: 07:30 de amanhã, intervalo de um dia, sem fim e sem filtro", () => {
		const out = planAgendaItem({ request: { kind: "brief", note: "Plano do dia", when: "2026-11-05T07:30" }, now: NOW, settings: SP });
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(hhmm(out.plan.dueAt, SP.timezone)).toBe("05 07:30");
		expect(out.plan).toMatchObject({ kind: "brief", intervalMinutes: AGENDA_BRIEF_INTERVAL_MINUTES, untilAt: null, maxRuns: null, eventFilter: null, adjustments: [] });
		expect(out.plan.requestedFor).toEqual(out.plan.dueAt);
	});
	it("o horário é EXATO: nada é empurrado para fora de silêncio nenhum", () => {
		const quiet: ProactiveSettings = { ...SP, quietStart: "22:00", quietEnd: "09:00" };
		const out = planAgendaItem({ request: { kind: "brief", note: "x", when: "2026-11-05T07:30" }, now: NOW, settings: quiet });
		expect(out.ok && hhmm(out.plan.dueAt, quiet.timezone)).toBe("05 07:30");
	});
	it("recusa com o campo certo: sem when, intervalo diferente de um dia, fim antes do começo, filtro de evento", () => {
		const err = (request: Record<string, unknown>) => {
			const r = planAgendaItem({ request: { kind: "brief", note: "x", when: "2026-11-05T07:30", ...request } as never, now: NOW, settings: SP });
			return r.ok ? "ok" : r.error;
		};
		expect(planAgendaItem({ request: { kind: "brief", note: "x" }, now: NOW, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("needs when") });
		expect(err({ everyMinutes: 180 })).toMatch(/once a day/);
		expect(err({ until: "2026-11-05T06:00" })).toMatch(/until must be after/);
		expect(err({ maxRuns: 0 })).toMatch(/maxRuns/);
		expect(err({ eventFilter: { source: "email", from: "a@b.com" } })).toMatch(/intent only/);
		expect(err({ when: "ontem" })).toMatch(/^when:/);
		expect(err({ everyMinutes: AGENDA_BRIEF_INTERVAL_MINUTES })).toBe("ok");
	});
});

describe("nextBriefOccurrence: a mesma hora do relógio do dono", () => {
	const anchor = new Date("2026-11-05T10:30:00.000Z"); // 07:30 em São Paulo
	it("depois de rodar às 07:31, o próximo é amanhã às 07:30 (não 24h depois do fim do run)", () => {
		const next = nextBriefOccurrence(anchor, new Date("2026-11-05T10:33:00.000Z"), "America/Sao_Paulo");
		expect(next.toISOString()).toBe("2026-11-06T10:30:00.000Z");
	});
	it("se ainda não deu a hora de hoje, é hoje", () => {
		expect(nextBriefOccurrence(anchor, new Date("2026-11-06T09:00:00.000Z"), "America/Sao_Paulo").toISOString()).toBe("2026-11-06T10:30:00.000Z");
	});
	it("o worker parado por dias não acumula: sempre o PRÓXIMO horário futuro", () => {
		expect(nextBriefOccurrence(anchor, new Date("2026-11-20T12:00:00.000Z"), "America/Sao_Paulo").toISOString()).toBe("2026-11-21T10:30:00.000Z");
	});
	it("atravessa o horário de verão mantendo 07:30 no relógio local (Nova York, 1º/11/2026)", () => {
		const ny = new Date("2026-10-31T11:30:00.000Z"); // 07:30 EDT
		const next = nextBriefOccurrence(ny, new Date("2026-10-31T11:40:00.000Z"), "America/New_York");
		expect(hhmm(next, "America/New_York")).toBe("01 07:30");
		expect(next.toISOString()).toBe("2026-11-01T12:30:00.000Z");
	});
});

describe("settle do brief", () => {
	const item = { kind: "brief" as const, intervalMinutes: AGENDA_BRIEF_INTERVAL_MINUTES, untilAt: null, maxRuns: null, runCount: 1, noChangeStreak: 0, requestedFor: new Date("2026-11-05T10:30:00.000Z") };
	it("update agenda o próximo para amanhã na mesma hora e posta", () => {
		const out = settleAgendaRun({ item, outcome: "update", hasMessage: true, now: new Date("2026-11-05T10:33:00.000Z"), settings: SP });
		expect(out).toMatchObject({ status: "pending", post: true, noChangeStreak: 0 });
		expect(out.dueAt?.toISOString()).toBe("2026-11-06T10:30:00.000Z");
	});
	it("sem o horário pedido (linha antiga) cai no espaçamento comum", () => {
		const out = settleAgendaRun({ item: { ...item, requestedFor: null }, outcome: "update", hasMessage: true, now: new Date("2026-11-05T10:33:00.000Z"), settings: SP });
		expect(out.dueAt?.toISOString()).toBe("2026-11-06T10:33:00.000Z");
	});
	it("respeita fim e máximo de execuções", () => {
		expect(settleAgendaRun({ item: { ...item, untilAt: new Date("2026-11-06T09:00:00.000Z") }, outcome: "update", hasMessage: true, now: new Date("2026-11-05T10:33:00.000Z"), settings: SP })).toMatchObject({ status: "done", endReason: "expired" });
		expect(settleAgendaRun({ item: { ...item, maxRuns: 1 }, outcome: "update", hasMessage: true, now: new Date("2026-11-05T10:33:00.000Z"), settings: SP })).toMatchObject({ status: "done", endReason: "max_runs" });
	});
	it("run sem resultado: tenta amanhã na mesma hora e só na 3ª falha encerra avisando", () => {
		const first = settleAgendaRunWithoutResult({ item: { ...item, missingResults: 0 }, hasText: false, now: new Date("2026-11-05T10:33:00.000Z"), settings: SP });
		expect(first).toMatchObject({ status: "pending", post: false, missingResults: 1 });
		expect(first.dueAt?.toISOString()).toBe("2026-11-06T10:30:00.000Z");
		expect(settleAgendaRunWithoutResult({ item: { ...item, missingResults: 2 }, hasText: false, now: new Date("2026-11-05T10:33:00.000Z"), settings: SP })).toMatchObject({ status: "done", endReason: "no_result", post: true });
	});
});

describe("planAgendaWake: avisos ignorados", () => {
	const wake = (kind: string, ignoredStreak: number) => ({ item: { status: "pending", kind, runCount: 1, maxRuns: null, untilAt: null, ignoredStreak }, now: NOW, settings: SP, noticeIgnored: null });
	it("brief tolera o fim de semana: só para depois de 7 planos seguidos sem leitura; os outros param em 2", () => {
		expect(planAgendaWake(wake("brief", AGENDA_IGNORED_NOTICE_LIMIT))).toMatchObject({ action: "run" });
		expect(planAgendaWake(wake("brief", AGENDA_BRIEF_IGNORED_NOTICE_LIMIT))).toMatchObject({ action: "stop", reason: "ignored_notices" });
		expect(planAgendaWake(wake("watch", AGENDA_IGNORED_NOTICE_LIMIT))).toMatchObject({ action: "stop", reason: "ignored_notices" });
	});
});
