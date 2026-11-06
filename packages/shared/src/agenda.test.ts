import { describe, expect, it } from "vitest";
import {
	AGENDA_IGNORED_NOTICE_LIMIT,
	AGENDA_MAX_ACTIVE_PER_OWNER,
	AGENDA_MIN_INTERVAL_MINUTES,
	findDuplicateAgendaItem,
	matchEventFilter,
	nextIgnoredStreak,
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

describe("findDuplicateAgendaItem", () => {
	it("mesmo tipo e nota (ignora caixa e acento) é duplicata; tipo diferente não", () => {
		const items = [{ kind: "watch", note: "Preço do Notebook" }, { kind: "remind", note: "ligar" }];
		expect(findDuplicateAgendaItem(items, { kind: "watch", note: "preco do notebook" })).toBe(items[0]);
		expect(findDuplicateAgendaItem(items, { kind: "remind", note: "preço do notebook" })).toBeUndefined();
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
	const base = { status: "pending", kind: "watch", runCount: 3, maxRuns: null, untilAt: null, ignoredStreak: 0 };
	const wake = (item: Partial<typeof base>, noticeIgnored: boolean | null = null, now = NOW) => planAgendaWake({ item: { ...base, ...item }, now, settings: SP, noticeIgnored });

	it("caminho normal roda", () => {
		expect(wake({})).toEqual({ action: "run", ignoredStreak: 0 });
	});

	it("vigência vencida e maxRuns encerram antes de gastar run", () => {
		expect(wake({ untilAt: new Date(NOW.getTime() - 1) })).toMatchObject({ action: "stop", reason: "expired" });
		expect(wake({ maxRuns: 3 })).toMatchObject({ action: "stop", reason: "max_runs" });
		expect(wake({ maxRuns: 4 })).toMatchObject({ action: "run" });
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

	it("limite por dono é uma constante de política (20)", () => {
		expect(AGENDA_MAX_ACTIVE_PER_OWNER).toBe(20);
	});
});

describe("settleAgendaRun", () => {
	const watch = { intervalMinutes: 120, untilAt: null, maxRuns: null, runCount: 1, noChangeStreak: 0 };
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

	it("maxRuns e untilAt encerram o recorrente", () => {
		expect(settle({ maxRuns: 1 }, "no_change")).toMatchObject({ status: "done", endReason: "max_runs" });
		expect(settle({ untilAt: new Date(NOW.getTime() + 30 * 60_000) }, "no_change")).toMatchObject({ status: "done", endReason: "expired" });
	});
});

describe("settleAgendaRunWithoutResult", () => {
	const item = { intervalMinutes: 120, untilAt: null, maxRuns: null, runCount: 1, noChangeStreak: 0, missingResults: 0 };
	const settle = (over: Partial<typeof item>, kind: "remind" | "watch" | "intent", hasText: boolean) =>
		settleAgendaRunWithoutResult({ item: { ...item, ...over }, kind, hasText, now: NOW, settings: SP });

	it("lembrete: o texto é o conteúdo, sai e o item fecha", () => {
		expect(settle({ intervalMinutes: null as never }, "remind", true)).toMatchObject({ status: "done", post: true, missingResults: 0 });
		expect(settle({ intervalMinutes: null as never }, "remind", false)).toMatchObject({ post: false });
	});

	it("vigia: não fala sem o sinal, conta a falha e na terceira encerra avisando uma vez", () => {
		expect(settle({}, "watch", true)).toMatchObject({ status: "pending", post: false, missingResults: 1 });
		expect(settle({ missingResults: 1 }, "watch", true)).toMatchObject({ status: "pending", missingResults: 2 });
		expect(settle({ missingResults: 2 }, "watch", true)).toMatchObject({ status: "done", endReason: "no_result", post: true, missingResults: 3 });
	});
});
