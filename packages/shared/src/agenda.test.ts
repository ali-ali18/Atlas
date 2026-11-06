import { describe, expect, it } from "vitest";
import {
	AGENDA_IGNORED_NOTICE_LIMIT,
	AGENDA_MAX_ACTIVE_PER_OWNER,
	AGENDA_MIN_INTERVAL_MINUTES,
	findDuplicateAgendaItem,
	matchEventFilter,
	nextAgendaEventWindow,
	nextIgnoredStreak,
	planAgendaEventWake,
	AGENDA_EVENT_MAX_WAKES_PER_DAY,
	AGENDA_EVENT_MIN_GAP_MINUTES,
	nextWatchDelay,
	parseAgendaEventFilter,
	planAgendaItem,
	planAgendaWake,
	settleAgendaRun,
	settleAgendaRunWithoutResult,
	wasNoticeIgnored,
	watchBackoffFactor,
	type AgendaEvent,
} from "./agenda.js";
import { DEFAULT_PROACTIVE_SETTINGS, localParts, type ProactiveSettings } from "./proactive.js";

const SP: ProactiveSettings = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone: "America/Sao_Paulo" };
const NY: ProactiveSettings = { ...SP, timezone: "America/New_York" };
// Quarta 2026-11-04, 10:00 em São Paulo (UTC-3).
const NOW = new Date("2026-11-04T13:00:00.000Z");
const local = (date: Date, tz: string) => {
	const p = localParts(date, tz);
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

describe("planAgendaItem: remind", () => {
	it("lembrete de uma vez: horário no fuso do dono, sem intervalo, uma execução", () => {
		const out = planAgendaItem({ request: { kind: "remind", note: "Ligar para o contador", when: "2026-11-05T10:00" }, now: NOW, settings: SP });
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(local(out.plan.dueAt, SP.timezone)).toBe("2026-11-05 10:00");
		expect(out.plan).toMatchObject({ kind: "remind", intervalMinutes: null, untilAt: null, maxRuns: 1, movedForQuietHours: false, adjustments: [] });
	});

	it("pedido para dentro do silêncio vai para o fim dele e avisa o ajuste", () => {
		const out = planAgendaItem({ request: { kind: "remind", note: "x", when: "2026-11-05T23:30" }, now: NOW, settings: SP });
		expect(out.ok && local(out.plan.dueAt, SP.timezone)).toBe("2026-11-06 08:00");
		expect(out.ok && out.plan.movedForQuietHours).toBe(true);
		expect(out.ok && out.plan.adjustments).toContain("moved out of the owner's quiet hours");
		expect(out.ok && local(out.plan.requestedFor, SP.timezone)).toBe("2026-11-05 23:30");
	});

	it("sem quando, no passado, nota vazia ou grande demais: erro que diz o que falta", () => {
		expect(planAgendaItem({ request: { kind: "remind", note: "x" }, now: NOW, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("needs when") });
		expect(planAgendaItem({ request: { kind: "remind", note: "x", when: "2026-11-01T10:00" }, now: NOW, settings: SP }).ok).toBe(false);
		expect(planAgendaItem({ request: { kind: "remind", note: "   ", when: "2026-11-05T10:00" }, now: NOW, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("note is empty") });
		expect(planAgendaItem({ request: { kind: "remind", note: "a".repeat(1001), when: "2026-11-05T10:00" }, now: NOW, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("1000") });
	});

	it("until e maxRuns em lembrete de uma vez são recusados (não descarta em silêncio)", () => {
		const out = planAgendaItem({ request: { kind: "remind", note: "x", when: "2026-11-05T10:00", maxRuns: 3 }, now: NOW, settings: SP });
		expect(out).toMatchObject({ ok: false, error: expect.stringContaining("recurring") });
	});

	it("lembrete recorrente sem fim ganha 14 dias e diz isso", () => {
		const out = planAgendaItem({ request: { kind: "remind", note: "Beber água", when: "2026-11-05T10:00", everyMinutes: 240 }, now: NOW, settings: SP });
		expect(out.ok && out.plan.untilAt?.toISOString()).toBe("2026-11-18T13:00:00.000Z");
		expect(out.ok && out.plan.adjustments[0]).toContain("14 days");
	});
});

describe("planAgendaItem: watch", () => {
	it("precisa de intervalo; abaixo de 2h só com pedido explícito; abaixo de 15 min nunca", () => {
		expect(planAgendaItem({ request: { kind: "watch", note: "preço" }, now: NOW, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("everyMinutes") });
		expect(planAgendaItem({ request: { kind: "watch", note: "preço", everyMinutes: 60 }, now: NOW, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("explicitly asked") });
		const asked = planAgendaItem({ request: { kind: "watch", note: "preço", everyMinutes: 60, ownerAskedShortInterval: true }, now: NOW, settings: SP });
		expect(asked.ok && asked.plan.intervalMinutes).toBe(60);
		expect(planAgendaItem({ request: { kind: "watch", note: "preço", everyMinutes: 10, ownerAskedShortInterval: true }, now: NOW, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("at least 15") });
		expect(planAgendaItem({ request: { kind: "watch", note: "preço", everyMinutes: AGENDA_MIN_INTERVAL_MINUTES }, now: NOW, settings: SP }).ok).toBe(true);
	});

	it("intervalo inválido: fracionado, negativo, maior que 30 dias", () => {
		for (const everyMinutes of [150.5, -5, 0, 60 * 24 * 31]) {
			expect(planAgendaItem({ request: { kind: "watch", note: "x", everyMinutes }, now: NOW, settings: SP }).ok).toBe(false);
		}
	});

	it("sem quando, a primeira checagem é daqui a um intervalo; sem fim, 14 dias", () => {
		const out = planAgendaItem({ request: { kind: "watch", note: "preço do notebook", everyMinutes: 360 }, now: NOW, settings: SP });
		expect(out.ok && local(out.plan.dueAt, SP.timezone)).toBe("2026-11-04 16:00");
		expect(out.ok && out.plan.untilAt?.toISOString()).toBe("2026-11-18T13:00:00.000Z");
	});

	it("com maxRuns declarado não ganha o fim padrão", () => {
		const out = planAgendaItem({ request: { kind: "watch", note: "x", everyMinutes: 180, maxRuns: 10 }, now: NOW, settings: SP });
		expect(out.ok && out.plan).toMatchObject({ maxRuns: 10, untilAt: null });
	});

	it("primeira checagem cai no silêncio: vai para a manhã; fim antes dela é recusado", () => {
		const late = new Date("2026-11-05T01:30:00.000Z"); // 22:30 em SP
		const out = planAgendaItem({ request: { kind: "watch", note: "x", everyMinutes: 120 }, now: late, settings: SP });
		expect(out.ok && local(out.plan.dueAt, SP.timezone)).toBe("2026-11-05 08:00");
		expect(planAgendaItem({ request: { kind: "watch", note: "x", everyMinutes: 120, until: "2026-11-04T14:00:00Z" }, now: NOW, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("after the first run") });
		// o fim (02:00 local) vem depois do pedido (00:30) mas antes da manhã para onde o silêncio empurra a primeira checagem
		expect(planAgendaItem({ request: { kind: "watch", note: "x", everyMinutes: 120, until: "2026-11-05T02:00" }, now: late, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("after the end") });
	});

	it("fim além de 180 dias é recusado", () => {
		expect(planAgendaItem({ request: { kind: "watch", note: "x", everyMinutes: 180, until: "2027-06-01T10:00" }, now: NOW, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("180") });
	});

	it("maxRuns fora de 1..500 é recusado", () => {
		for (const maxRuns of [0, 501, 2.5]) expect(planAgendaItem({ request: { kind: "watch", note: "x", everyMinutes: 180, maxRuns }, now: NOW, settings: SP }).ok).toBe(false);
	});
});

describe("planAgendaItem: intent e brief", () => {
	it("intent exige filtro e não aceita relógio; sem fim dura 30 dias", () => {
		expect(planAgendaItem({ request: { kind: "intent", note: "avisar" }, now: NOW, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("eventFilter must be an object") });
		expect(planAgendaItem({ request: { kind: "intent", note: "x", eventFilter: { source: "email", from: "a@b.com" }, when: "2026-11-05T10:00" }, now: NOW, settings: SP }).ok).toBe(false);
		const ok = planAgendaItem({ request: { kind: "intent", note: "Resumir a fatura", eventFilter: { source: "email", from: "fatura@banco.com" } }, now: NOW, settings: SP });
		expect(ok.ok && ok.plan).toMatchObject({ kind: "intent", intervalMinutes: null, eventFilter: { source: "email", from: "fatura@banco.com" } });
		expect(ok.ok && ok.plan.untilAt?.toISOString()).toBe("2026-12-04T13:00:00.000Z");
	});

	it("eventFilter fora de intent é recusado; brief ainda não é criado por pedido", () => {
		expect(planAgendaItem({ request: { kind: "watch", note: "x", everyMinutes: 180, eventFilter: { source: "email", from: "a@b.com" } }, now: NOW, settings: SP }).ok).toBe(false);
		expect(planAgendaItem({ request: { kind: "brief", note: "x", when: "2026-11-05T08:00" }, now: NOW, settings: SP })).toMatchObject({ ok: false, error: expect.stringContaining("brief") });
		expect(planAgendaItem({ request: { kind: "nope" as never, note: "x" }, now: NOW, settings: SP }).ok).toBe(false);
	});
});

describe("planAgendaItem: when textual atravessando o horário de verão (auditoria F4, T4)", () => {
	const at = (when: string, now: string) => {
		const out = planAgendaItem({ request: { kind: "remind", note: "Ligar para o banco", when }, now: new Date(now), settings: NY });
		if (!out.ok) throw new Error(out.error);
		return out.plan;
	};

	it('"amanhã 9h" na véspera do fim do horário de verão (dia de 25h) cai às 9h locais, 14:00Z (UTC-5)', () => {
		// Sábado 31/10/2026 15:00 em Nova York (EDT, UTC-4); domingo 01/11 o relógio volta uma hora.
		const plan = at("amanhã 9h", "2026-10-31T19:00:00.000Z");
		expect(local(plan.dueAt, NY.timezone)).toBe("2026-11-01 09:00");
		expect(plan.dueAt.toISOString()).toBe("2026-11-01T14:00:00.000Z");
		expect(plan.movedForQuietHours).toBe(false);
	});

	it('"amanhã 9h" na véspera do início do horário de verão (dia de 23h) cai às 9h locais, 13:00Z (UTC-4)', () => {
		// Sábado 13/03/2027 12:00 em Nova York (EST, UTC-5); domingo 14/03 o relógio avança uma hora às 02:00.
		const plan = at("amanhã 9h", "2027-03-13T17:00:00.000Z");
		expect(local(plan.dueAt, NY.timezone)).toBe("2027-03-14 09:00");
		expect(plan.dueAt.toISOString()).toBe("2027-03-14T13:00:00.000Z");
	});

	it("o mesmo texto no mesmo fuso sem DST no meio não muda a hora local; ISO sem fuso também respeita a virada", () => {
		expect(local(at("amanhã 9h", "2026-11-04T19:00:00.000Z").dueAt, NY.timezone)).toBe("2026-11-05 09:00");
		const iso = at("2026-11-01T09:00", "2026-10-31T19:00:00.000Z");
		expect(iso.dueAt.toISOString()).toBe("2026-11-01T14:00:00.000Z");
	});
});

describe("findDuplicateAgendaItem", () => {
	const H = 3_600_000;
	const item = (kind: string, note: string, dueAt: Date, intervalMinutes: number | null = null) => ({ kind, note, dueAt, intervalMinutes });
	const plan = (kind: "remind" | "watch" | "intent", note: string, dueAt: Date, intervalMinutes: number | null = null) => ({ kind, note, dueAt, intervalMinutes });

	it("mesmo tipo, mesma nota (ignora caixa e acento) e mesmo horário é duplicata; tipo diferente não", () => {
		const items = [item("watch", "Preço do Notebook", NOW, 120), item("remind", "ligar", NOW)];
		expect(findDuplicateAgendaItem(items, plan("watch", "preco do notebook", NOW, 120))).toBe(items[0]);
		expect(findDuplicateAgendaItem(items, plan("remind", "preço do notebook", NOW))).toBeUndefined();
	});

	it("me lembra às 10h e às 20h com a mesma nota são DOIS itens; o mesmo horário (janela de 2h) dedupa (auditoria F4, C2)", () => {
		const ten = planAgendaItem({ request: { kind: "remind", note: "Tomar o remédio", when: "2026-11-05T10:00" }, now: NOW, settings: SP });
		const twenty = planAgendaItem({ request: { kind: "remind", note: "Tomar o remédio", when: "2026-11-05T20:00" }, now: NOW, settings: SP });
		const near = planAgendaItem({ request: { kind: "remind", note: "tomar o remedio", when: "2026-11-05T10:45" }, now: NOW, settings: SP });
		if (!ten.ok || !twenty.ok || !near.ok) throw new Error("plano inválido");
		const stored = [{ kind: "remind", note: ten.plan.note, dueAt: ten.plan.dueAt, intervalMinutes: null }];
		expect(findDuplicateAgendaItem(stored, twenty.plan)).toBeUndefined();
		expect(findDuplicateAgendaItem(stored, ten.plan)).toBe(stored[0]);
		expect(findDuplicateAgendaItem(stored, near.plan)).toBe(stored[0]);
		expect(findDuplicateAgendaItem(stored, plan("remind", "Tomar o remédio", new Date(ten.plan.dueAt.getTime() + 3 * H)))).toBeUndefined();
	});

	it("todo dia às 9h e todo dia às 21h com a mesma nota são DOIS itens; o mesmo horário dedupa (reauditoria F4, N2)", () => {
		const daily = (when: string) => {
			const planned = planAgendaItem({ request: { kind: "remind", note: "Tomar o remédio", everyMinutes: 1440, when }, now: NOW, settings: SP });
			if (!planned.ok) throw new Error("plano inválido");
			return planned.plan;
		};
		const nine = daily("2026-11-05T09:00");
		const stored = [{ kind: "remind", note: nine.note, dueAt: new Date(nine.dueAt.getTime() + 3 * 24 * H), intervalMinutes: 1440 }];
		expect(findDuplicateAgendaItem(stored, daily("2026-11-05T21:00"))).toBeUndefined();
		expect(findDuplicateAgendaItem(stored, daily("2026-11-05T09:30"))).toBe(stored[0]);
	});

	it("recorrente com o mesmo intervalo e intenção por evento não comparam horário", () => {
		const watching = [item("watch", "Preço do notebook", new Date(NOW.getTime() + 50 * H), 120)];
		expect(findDuplicateAgendaItem(watching, plan("watch", "Preço do notebook", NOW, 120))).toBe(watching[0]);
		expect(findDuplicateAgendaItem(watching, plan("watch", "Preço do notebook", NOW, 240))).toBeUndefined();
		const intents = [item("intent", "Resumir a fatura", new Date(NOW.getTime() + 20 * 24 * H))];
		expect(findDuplicateAgendaItem(intents, plan("intent", "Resumir a fatura", new Date(NOW.getTime() + 30 * 24 * H)))).toBe(intents[0]);
	});
});

describe("parseAgendaEventFilter e matchEventFilter", () => {
	const mail = (over: Partial<AgendaEvent> = {}): AgendaEvent => ({ source: "email", from: "Banco <fatura@banco.com>", subject: "Sua fatura de novembro", hasAttachment: true, ...over });

	it("valida por campo declarado: desconhecido, vazio, tipo errado", () => {
		expect(parseAgendaEventFilter({ source: "email", regex: ".*" })).toMatchObject({ ok: false, error: expect.stringContaining("Unknown eventFilter field(s): regex") });
		expect(parseAgendaEventFilter({ source: "email" })).toMatchObject({ ok: false, error: expect.stringContaining("at least one criterion") });
		expect(parseAgendaEventFilter({ source: "sms", from: "a" }).ok).toBe(false);
		expect(parseAgendaEventFilter({ source: "email", hasAttachment: "yes" }).ok).toBe(false);
		expect(parseAgendaEventFilter({ source: "email", from: "  " }).ok).toBe(false);
		expect(parseAgendaEventFilter({ source: "email", subjectContains: "x".repeat(201) }).ok).toBe(false);
		expect(parseAgendaEventFilter("x").ok).toBe(false);
	});

	it("remetente: endereço exato, domínio, subdomínio e @domínio; nome de exibição é ignorado", () => {
		const f = (from: string) => ({ source: "email" as const, from });
		expect(matchEventFilter(f("fatura@banco.com"), mail())).toBe(true);
		expect(matchEventFilter(f("FATURA@Banco.com"), mail())).toBe(true);
		expect(matchEventFilter(f("outro@banco.com"), mail())).toBe(false);
		expect(matchEventFilter(f("banco.com"), mail())).toBe(true);
		expect(matchEventFilter(f("@banco.com"), mail())).toBe(true);
		expect(matchEventFilter(f("banco.com"), mail({ from: "x@mail.banco.com" }))).toBe(true);
		// "bbanco.com" não é subdomínio de "banco.com"; o nome de exibição não conta
		expect(matchEventFilter(f("banco.com"), mail({ from: "x@bbanco.com" }))).toBe(false);
		expect(matchEventFilter(f("banco.com"), mail({ from: "banco.com <spam@evil.org>" }))).toBe(false);
	});

	it("assunto contém é literal e sem diferença de caixa; caractere de padrão não vira padrão", () => {
		const f = (subjectContains: string) => ({ source: "email" as const, subjectContains });
		expect(matchEventFilter(f("FATURA"), mail())).toBe(true);
		expect(matchEventFilter(f("boleto"), mail())).toBe(false);
		expect(matchEventFilter(f("fatura.*novembro"), mail())).toBe(false);
	});

	it("todos os critérios presentes precisam casar; anexo e fonte também", () => {
		const filter = { source: "email" as const, from: "banco.com", subjectContains: "fatura", hasAttachment: true };
		expect(matchEventFilter(filter, mail())).toBe(true);
		expect(matchEventFilter(filter, mail({ hasAttachment: false }))).toBe(false);
		expect(matchEventFilter(filter, mail({ subject: "Promoção" }))).toBe(false);
		expect(matchEventFilter({ source: "email", hasAttachment: false }, mail({ hasAttachment: false }))).toBe(true);
		expect(matchEventFilter(filter, { ...mail(), source: "sms" as never })).toBe(false);
	});
});

describe("nextWatchDelay", () => {
	it("espaça com as execuções seguidas sem novidade e respeita o teto", () => {
		expect([0, 2, 3, 5, 6, 9, 10, 99].map(watchBackoffFactor)).toEqual([1, 1, 2, 2, 4, 4, 8, 8]);
		const at = (noChangeStreak: number, intervalMinutes = 120) => {
			const out = nextWatchDelay({ now: NOW, intervalMinutes, noChangeStreak, settings: SP });
			return out.ok ? out.delayMinutes : -1;
		};
		expect(at(0)).toBe(120);
		expect(at(3)).toBe(240);
		expect(at(6)).toBe(480);
		expect(at(10)).toBe(960);
		// teto de 72h; intervalo maior que o teto manda
		expect(at(10, 1440)).toBe(4320);
		expect(at(10, 60 * 24 * 5)).toBe(60 * 24 * 5);
	});

	it("o próximo horário que cair no silêncio vai para a manhã seguinte", () => {
		const night = new Date("2026-11-05T00:00:00.000Z"); // 21:00 em SP
		const out = nextWatchDelay({ now: night, intervalMinutes: 120, noChangeStreak: 0, settings: SP });
		expect(out.ok && local(out.dueAt, SP.timezone)).toBe("2026-11-05 08:00");
		expect(out.ok && out.movedForQuietHours).toBe(true);
	});

	it("virada de dia e de mês: 23h ao fim do mês cai às 8h do dia 1", () => {
		const out = nextWatchDelay({ now: new Date("2026-12-01T01:30:00.000Z"), intervalMinutes: 120, noChangeStreak: 0, settings: SP });
		// 22:30 de 30/11 em SP + 2h = 00:30 de 01/12: silêncio até 08:00
		expect(out.ok && local(out.dueAt, SP.timezone)).toBe("2026-12-01 08:00");
	});

	it("o fuso é o do dono: o mesmo instante cai em horário diferente", () => {
		const now = new Date("2026-11-04T23:00:00.000Z"); // 20:00 SP, 18:00 NY
		const sp = nextWatchDelay({ now, intervalMinutes: 180, noChangeStreak: 0, settings: SP });
		const ny = nextWatchDelay({ now, intervalMinutes: 180, noChangeStreak: 0, settings: NY });
		expect(sp.ok && local(sp.dueAt, SP.timezone)).toBe("2026-11-05 08:00"); // 23:00 SP está no silêncio
		expect(ny.ok && local(ny.dueAt, NY.timezone)).toBe("2026-11-04 21:00"); // 21:00 NY está livre
	});

	it("DST (Nova York, 08/03/2026): 08:00 locais depois da mudança é 12:00Z, não 13:00Z", () => {
		// 07/03 22:30 em NY (EST, UTC-5) = 08/03 03:30Z. Mais 2h = 00:30 de 08/03 local (EST) → silêncio até 08:00 já em EDT.
		const out = nextWatchDelay({ now: new Date("2026-03-08T03:30:00.000Z"), intervalMinutes: 120, noChangeStreak: 0, settings: NY });
		expect(out.ok && local(out.dueAt, NY.timezone)).toBe("2026-03-08 08:00");
		expect(out.ok && out.dueAt.toISOString()).toBe("2026-03-08T12:00:00.000Z");
	});

	it("DST de saída (Nova York, 01/11/2026): 08:00 vale 13:00Z", () => {
		const out = nextWatchDelay({ now: new Date("2026-11-01T03:30:00.000Z"), intervalMinutes: 120, noChangeStreak: 0, settings: NY });
		expect(out.ok && out.dueAt.toISOString()).toBe("2026-11-01T13:00:00.000Z");
	});

	it("passou de untilAt: encerra", () => {
		const out = nextWatchDelay({ now: NOW, intervalMinutes: 120, noChangeStreak: 0, settings: SP, untilAt: new Date(NOW.getTime() + 60 * 60_000) });
		expect(out).toEqual({ ok: false, reason: "past_until" });
	});
});

describe("aviso ignorado", () => {
	const noticeAt = new Date("2026-11-04T15:00:00.000Z");
	const before = new Date("2026-11-04T14:00:00.000Z");
	const after = new Date("2026-11-04T15:30:00.000Z");

	it("ignorado só quando o dono nem abriu a conversa nem escreveu depois do aviso", () => {
		expect(wasNoticeIgnored({ noticeAt, lastReadAt: before, lastOwnerMessageAt: before })).toBe(true);
		expect(wasNoticeIgnored({ noticeAt, lastReadAt: null, lastOwnerMessageAt: null })).toBe(true);
		expect(wasNoticeIgnored({ noticeAt, lastReadAt: after, lastOwnerMessageAt: null })).toBe(false);
		expect(wasNoticeIgnored({ noticeAt, lastReadAt: before, lastOwnerMessageAt: after })).toBe(false);
		expect(wasNoticeIgnored({ noticeAt, lastReadAt: noticeAt, lastOwnerMessageAt: null })).toBe(false);
	});

	it("contagem soma no ignorado e zera no visto", () => {
		expect(nextIgnoredStreak(0, true)).toBe(1);
		expect(nextIgnoredStreak(1, true)).toBe(2);
		expect(nextIgnoredStreak(1, false)).toBe(0);
	});
});

describe("planAgendaWake", () => {
	const base = { status: "pending", kind: "watch", runCount: 3, maxRuns: null as number | null, untilAt: null, ignoredStreak: 0, missingResults: 0 };
	const wake = (item: Partial<typeof base>, noticeIgnored: boolean | null = null, now = NOW) => planAgendaWake({ item: { ...base, ...item }, now, settings: SP, noticeIgnored });

	it("caminho normal roda", () => {
		expect(wake({})).toEqual({ action: "run", ignoredStreak: 0 });
	});

	it("vigência vencida e maxRuns encerram antes de gastar run", () => {
		expect(wake({ untilAt: new Date(NOW.getTime() - 1) })).toMatchObject({ action: "stop", reason: "expired" });
		expect(wake({ maxRuns: 3 })).toMatchObject({ action: "stop", reason: "max_runs" });
		expect(wake({ maxRuns: 4 })).toMatchObject({ action: "run" });
	});

	it("lembrete de uma vez com nova tentativa pendente não para por maxRuns (a tentativa é a mesma execução)", () => {
		expect(wake({ kind: "remind", runCount: 1, maxRuns: 1 })).toMatchObject({ action: "stop", reason: "max_runs" });
		expect(wake({ kind: "remind", runCount: 2, maxRuns: 1, missingResults: 1 })).toMatchObject({ action: "run" });
		expect(wake({ kind: "watch", runCount: 2, maxRuns: 1, missingResults: 1 })).toMatchObject({ action: "stop", reason: "max_runs" });
	});

	it("o segundo aviso seguido ignorado encerra; o primeiro só conta", () => {
		expect(AGENDA_IGNORED_NOTICE_LIMIT).toBe(2);
		expect(wake({ ignoredStreak: 0 }, true)).toEqual({ action: "run", ignoredStreak: 1 });
		expect(wake({ ignoredStreak: 1 }, true)).toEqual({ action: "stop", reason: "ignored_notices", ignoredStreak: 2 });
		// visto no meio zera a conta
		expect(wake({ ignoredStreak: 1 }, false)).toEqual({ action: "run", ignoredStreak: 0 });
		// sem aviso a avaliar mantém a conta
		expect(wake({ ignoredStreak: 1 }, null)).toEqual({ action: "run", ignoredStreak: 1 });
	});

	it("dentro do silêncio adia para o fim dele", () => {
		const night = new Date("2026-11-05T03:00:00.000Z"); // 00:00 em SP
		const out = wake({}, null, night);
		expect(out).toMatchObject({ action: "defer", reason: "quiet_hours" });
		expect(out.action === "defer" && local(out.dueAt, SP.timezone)).toBe("2026-11-05 08:00");
	});

	it("intenção por evento não adia no silêncio (o evento da noite não se perde), mas os outros freios valem", () => {
		const night = new Date("2026-11-05T03:00:00.000Z");
		expect(wake({ kind: "intent" }, null, night)).toEqual({ action: "run", ignoredStreak: 0 });
		expect(wake({ kind: "intent", maxRuns: 3 }, null, night)).toMatchObject({ action: "stop", reason: "max_runs" });
		expect(wake({ kind: "intent", ignoredStreak: 1 }, true, night)).toMatchObject({ action: "stop", reason: "ignored_notices" });
	});

	it("limite por dono é uma constante de política (20)", () => {
		expect(AGENDA_MAX_ACTIVE_PER_OWNER).toBe(20);
	});
});

describe("settleAgendaRun", () => {
	const watch = { kind: "watch" as const, intervalMinutes: 120, untilAt: null, maxRuns: null, runCount: 1, noChangeStreak: 0 };
	const settle = (over: Partial<typeof watch>, outcome: "no_change" | "update" | "done", hasMessage = false) =>
		settleAgendaRun({ item: { ...watch, ...over }, outcome, hasMessage, now: NOW, settings: SP });

	it("no_change nunca posta, soma a sequência e espaça", () => {
		const first = settle({}, "no_change", true);
		expect(first).toMatchObject({ status: "pending", post: false, noChangeStreak: 1, endReason: null });
		expect(first.dueAt && local(first.dueAt, SP.timezone)).toBe("2026-11-04 12:00");
		const third = settle({ noChangeStreak: 2 }, "no_change");
		expect(third.noChangeStreak).toBe(3);
		expect(third.dueAt && local(third.dueAt, SP.timezone)).toBe("2026-11-04 14:00"); // 4h de espaçamento
	});

	it("update posta com mensagem, zera a sequência e volta ao intervalo base", () => {
		const out = settle({ noChangeStreak: 7 }, "update", true);
		expect(out).toMatchObject({ status: "pending", post: true, noChangeStreak: 0 });
		expect(out.dueAt && local(out.dueAt, SP.timezone)).toBe("2026-11-04 12:00");
		expect(settle({}, "update", false).post).toBe(false);
	});

	it("done encerra; uma vez só encerra mesmo com update", () => {
		expect(settle({}, "done", true)).toMatchObject({ status: "done", dueAt: null, endReason: "done", post: true });
		expect(settle({ intervalMinutes: null as never }, "update", true)).toMatchObject({ status: "done", endReason: "completed", post: true });
	});

	it("intent segue valendo depois de acordar (dueAt = fim da vigência) até done ou maxRuns", () => {
		const until = new Date(NOW.getTime() + 20 * 86_400_000);
		const intent = { kind: "intent" as const, intervalMinutes: null, untilAt: until, maxRuns: null, runCount: 1, noChangeStreak: 0 };
		const again = settleAgendaRun({ item: intent, outcome: "update", hasMessage: true, now: NOW, settings: SP });
		expect(again).toMatchObject({ status: "pending", post: true });
		expect(again.dueAt?.toISOString()).toBe(until.toISOString());
		expect(settleAgendaRun({ item: { ...intent, maxRuns: 1 }, outcome: "update", hasMessage: true, now: NOW, settings: SP })).toMatchObject({ status: "done", endReason: "max_runs" });
		expect(settleAgendaRun({ item: intent, outcome: "done", hasMessage: false, now: NOW, settings: SP })).toMatchObject({ status: "done", endReason: "done" });
	});

	it("maxRuns e untilAt encerram o recorrente", () => {
		expect(settle({ maxRuns: 1 }, "no_change")).toMatchObject({ status: "done", endReason: "max_runs" });
		expect(settle({ untilAt: new Date(NOW.getTime() + 30 * 60_000) }, "no_change")).toMatchObject({ status: "done", endReason: "expired" });
	});
});

describe("settleAgendaRunWithoutResult", () => {
	const item = { kind: "watch" as const, intervalMinutes: 120, untilAt: null, maxRuns: null, runCount: 1, noChangeStreak: 0, missingResults: 0 };
	const settle = (over: Partial<typeof item>, kind: "remind" | "watch" | "intent", hasText: boolean) =>
		settleAgendaRunWithoutResult({ item: { ...item, ...over, kind }, hasText, now: NOW, settings: SP });

	it("lembrete: o texto é o conteúdo, sai e o item fecha", () => {
		expect(settle({ intervalMinutes: null as never }, "remind", true)).toMatchObject({ status: "done", post: true, missingResults: 0 });
	});

	it("lembrete sem resultado e sem texto nunca some: reagenda e, esgotado, entrega a própria nota (auditoria F4, C1/B2)", () => {
		const once = { intervalMinutes: null as never, maxRuns: 1 };
		const first = settle(once, "remind", false);
		expect(first).toMatchObject({ status: "pending", post: false, missingResults: 1, endReason: null });
		expect(first.deliverNote).toBeUndefined();
		expect(first.dueAt && local(first.dueAt, SP.timezone)).toBe("2026-11-04 10:30");
		expect(settle({ ...once, missingResults: 1 }, "remind", false)).toMatchObject({ status: "pending", missingResults: 2 });
		expect(settle({ ...once, missingResults: 2 }, "remind", false)).toMatchObject({ status: "done", dueAt: null, post: true, deliverNote: true, endReason: "reminder_note" });
	});

	it("lembrete recorrente esgotado entrega a nota e segue no ritmo", () => {
		const out = settle({ missingResults: 2 }, "remind", false);
		expect(out).toMatchObject({ status: "pending", post: true, deliverNote: true, missingResults: 0, endReason: null });
		expect(out.dueAt).not.toBeNull();
	});

	it("a nova tentativa cai fora do silêncio e, se passar do fim, entrega a nota", () => {
		const late = settleAgendaRunWithoutResult({ item: { ...item, kind: "remind", intervalMinutes: null, maxRuns: 1, missingResults: 0 }, hasText: false, now: new Date("2026-11-05T01:00:00.000Z"), settings: SP });
		expect(late.dueAt && local(late.dueAt, SP.timezone)).toBe("2026-11-05 08:00");
		const ended = settle({ intervalMinutes: null as never, maxRuns: 1, untilAt: new Date(NOW.getTime() + 10 * 60_000) }, "remind", false);
		expect(ended).toMatchObject({ status: "done", deliverNote: true, endReason: "reminder_note" });
	});

	it("vigia: não fala sem o sinal, conta a falha e na terceira encerra avisando uma vez", () => {
		expect(settle({}, "watch", true)).toMatchObject({ status: "pending", post: false, missingResults: 1 });
		expect(settle({ missingResults: 1 }, "watch", true)).toMatchObject({ status: "pending", missingResults: 2 });
		expect(settle({ missingResults: 2 }, "watch", true)).toMatchObject({ status: "done", endReason: "no_result", post: true, missingResults: 3 });
	});
});

describe("acordar por evento: espaçamento e teto diário (auditoria F4, B4)", () => {
	const MIN = 60_000;
	const closed = { windowStartAt: null, windowCount: 0 };

	it("valores: 30 min entre acordares e 8 por dia (pior caso 8 runs/dia/item, antes ~144)", () => {
		expect(AGENDA_EVENT_MIN_GAP_MINUTES).toBe(30);
		expect(AGENDA_EVENT_MAX_WAKES_PER_DAY).toBe(8);
	});

	it("caso legítimo: um e-mail por dia acorda sempre; rajada dentro do espaçamento é juntada", () => {
		expect(planAgendaEventWake({ now: NOW, lastWakeAt: null, minGapMinutes: 30, window: closed })).toBe("wake");
		expect(planAgendaEventWake({ now: NOW, lastWakeAt: new Date(NOW.getTime() - 20 * MIN), minGapMinutes: 30, window: closed })).toBe("gap");
		expect(planAgendaEventWake({ now: NOW, lastWakeAt: new Date(NOW.getTime() - 31 * MIN), minGapMinutes: 30, window: closed })).toBe("wake");
	});

	it("o teto de 8 por janela de 24h segura o resto; passadas 24h a janela reabre", () => {
		const start = new Date(NOW.getTime() - 5 * 3_600_000);
		const full = { windowStartAt: start, windowCount: AGENDA_EVENT_MAX_WAKES_PER_DAY };
		const lastWakeAt = new Date(NOW.getTime() - 40 * MIN);
		expect(planAgendaEventWake({ now: NOW, lastWakeAt, minGapMinutes: 30, window: full })).toBe("daily_cap");
		expect(planAgendaEventWake({ now: NOW, lastWakeAt, minGapMinutes: 30, window: { ...full, windowCount: 7 } })).toBe("wake");
		const nextDay = new Date(start.getTime() + 24 * 3_600_000 + MIN);
		expect(planAgendaEventWake({ now: nextDay, lastWakeAt, minGapMinutes: 30, window: full })).toBe("wake");
	});

	it("a janela conta cada acordar e reabre depois de 24h", () => {
		const first = nextAgendaEventWindow(closed, NOW);
		expect(first).toEqual({ windowStartAt: NOW, windowCount: 1 });
		const later = new Date(NOW.getTime() + 3_600_000);
		expect(nextAgendaEventWindow(first, later)).toEqual({ windowStartAt: NOW, windowCount: 2 });
		const nextDay = new Date(NOW.getTime() + 25 * 3_600_000);
		expect(nextAgendaEventWindow({ windowStartAt: NOW, windowCount: 8 }, nextDay)).toEqual({ windowStartAt: nextDay, windowCount: 1 });
	});
});
