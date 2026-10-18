import { describe, expect, it } from "vitest";
import { DEFAULT_PROACTIVE_SETTINGS, REMINDER_STAGES_MAX, advanceFollowupStages, localParts, nextPendingStageIndex, normalizeNewStages, parseFollowupStages, setFollowupStageAt, planFollowupReschedule, quickRescheduleOptions, suggestReminderStages, toLocalInputValue } from "./proactive.js";

const SP = "America/Sao_Paulo";
// Quarta 2026-10-14, 10:00 em São Paulo.
const NOW = new Date("2026-10-14T13:00:00.000Z");
const settings = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone: SP };

function days(dates: Date[]): string[] {
	return dates.map((d) => {
		const p = localParts(d, SP);
		return `${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")} ${p.hour}h`;
	});
}

describe("suggestReminderStages", () => {
	it("prazo de 30 dias: um logo amanhã, intermediários, um 2 dias antes", () => {
		const out = suggestReminderStages(NOW, new Date("2026-11-13T21:00:00.000Z"), SP);
		expect(out.length).toBeGreaterThanOrEqual(3);
		expect(out.length).toBeLessThanOrEqual(REMINDER_STAGES_MAX);
		const labels = days(out);
		expect(labels[0]).toBe("15/10 9h");
		expect(labels.at(-1)).toBe("11/11 9h");
		expect(out.every((d, i) => i === 0 || d > out[i - 1]!)).toBe(true);
	});

	it("importante soma a véspera sem passar do teto", () => {
		const out = suggestReminderStages(NOW, new Date("2026-11-13T21:00:00.000Z"), SP, { important: true });
		expect(out.length).toBeLessThanOrEqual(REMINDER_STAGES_MAX);
		expect(days(out).at(-1)).toBe("12/11 9h");
		expect(days(out)).toContain("11/11 9h");
	});

	it("prazo curto (3 dias) gera só um lembrete futuro", () => {
		expect(days(suggestReminderStages(NOW, new Date("2026-10-17T15:00:00.000Z"), SP))).toEqual(["15/10 9h"]);
	});

	it("prazo amanhã ou no passado não gera nada", () => {
		expect(suggestReminderStages(NOW, new Date("2026-10-15T15:00:00.000Z"), SP)).toEqual([]);
		expect(suggestReminderStages(NOW, new Date("2026-10-01T15:00:00.000Z"), SP)).toEqual([]);
	});

	it("respeita o fuso e o silêncio quando as configurações são passadas", () => {
		const out = suggestReminderStages(NOW, new Date("2026-10-20T15:00:00.000Z"), SP, {
			settings: { ...settings, quietStart: "08:00", quietEnd: "11:00" },
		});
		expect(days(out)[0]).toBe("15/10 11h");
		const utc = suggestReminderStages(NOW, new Date("2026-10-20T15:00:00.000Z"), "UTC");
		expect(utc[0]!.toISOString()).toBe("2026-10-15T09:00:00.000Z");
	});
});

describe("planFollowupReschedule", () => {
	it("lê horário sem fuso no fuso da conta", () => {
		const plan = planFollowupReschedule({ when: "2026-10-20T09:00", now: NOW, settings });
		expect(plan).toMatchObject({ ok: true, movedForQuietHours: false });
		if (plan.ok) expect(plan.dueAt.toISOString()).toBe("2026-10-20T12:00:00.000Z");
	});

	it("rejeita passado", () => {
		const plan = planFollowupReschedule({ when: "2026-10-10T09:00", now: NOW, settings });
		expect(plan.ok).toBe(false);
	});

	it("empurra para 08:00 dentro do silêncio e avisa", () => {
		const plan = planFollowupReschedule({ when: "2026-10-20T23:30", now: NOW, settings });
		expect(plan.ok).toBe(true);
		if (plan.ok) {
			expect(plan.movedForQuietHours).toBe(true);
			expect(plan.dueAt.toISOString()).toBe("2026-10-21T11:00:00.000Z");
			expect(plan.requestedFor.toISOString()).toBe("2026-10-21T02:30:00.000Z");
		}
	});

	it("outro fuso muda o instante", () => {
		const plan = planFollowupReschedule({ when: "2026-10-20T09:00", now: NOW, settings: { ...settings, timezone: "UTC" } });
		if (plan.ok) expect(plan.dueAt.toISOString()).toBe("2026-10-20T09:00:00.000Z");
	});
});

describe("quickRescheduleOptions", () => {
	it("atalhos em horário de parede do fuso da conta (quarta 14/10)", () => {
		const options = quickRescheduleOptions(NOW, SP);
		expect(options.map((o) => o.label)).toEqual(["Amanhã 9h", "Em 3 dias", "Próxima segunda 9h"]);
		expect(options.map((o) => o.local)).toEqual(["2026-10-15T09:00", "2026-10-17T09:00", "2026-10-19T09:00"]);
	});

	it("numa segunda, 'próxima segunda' é a da semana seguinte; o fuso decide o dia", () => {
		const monday = new Date("2026-10-19T13:00:00.000Z");
		expect(quickRescheduleOptions(monday, SP)[2]!.local).toBe("2026-10-26T09:00");
		const lateNight = new Date("2026-10-15T01:30:00.000Z"); // 22:30 de quarta em SP, já quinta em UTC
		expect(quickRescheduleOptions(lateNight, SP)[0]!.local).toBe("2026-10-15T09:00");
		expect(quickRescheduleOptions(lateNight, "UTC")[0]!.local).toBe("2026-10-16T09:00");
	});

	it("toLocalInputValue devolve a hora de parede", () => {
		expect(toLocalInputValue(new Date("2026-10-20T12:00:00.000Z"), SP)).toBe("2026-10-20T09:00");
	});
});

describe("avisos de um lembrete", () => {
	const fb = new Date("2026-11-06T12:00:00.000Z");
	const three = [
		{ at: "2026-10-15T12:00:00.000Z", firedAt: null },
		{ at: "2026-10-30T12:00:00.000Z", firedAt: null },
		{ at: "2026-11-11T12:00:00.000Z", firedAt: null },
	];

	it("lembrete antigo (sem JSON) vira um aviso só; concluído vem como enviado", () => {
		expect(parseFollowupStages(null, fb)).toEqual([{ at: fb.toISOString(), firedAt: null }]);
		expect(parseFollowupStages("lixo", fb, true)[0]!.firedAt).toBe(fb.toISOString());
	});

	it("lê, descarta itens inválidos, ordena (enviados antes) e limita a 4", () => {
		const raw = [{ at: "2026-11-11T12:00:00Z" }, { at: "x" }, { at: "2026-10-15T12:00:00Z", firedAt: "2026-10-15T12:01:00Z" }, { at: "2026-10-20T12:00:00Z" }, 3, null, { at: "2026-10-21T12:00:00Z" }, { at: "2026-10-22T12:00:00Z" }];
		const out = parseFollowupStages(raw, fb);
		expect(out.length).toBe(4);
		expect(out[0]!.firedAt).toBeTruthy();
		expect(out.slice(1).map((s) => s.at)).toEqual([...out.slice(1).map((s) => s.at)].sort());
	});

	it("dispara na ordem e só encerra depois do último", () => {
		let stages = parseFollowupStages(three, fb);
		const now = new Date("2026-10-15T12:00:00.000Z");
		const a = advanceFollowupStages(stages, now);
		expect(a.nextDueAt?.toISOString()).toBe("2026-10-30T12:00:00.000Z");
		expect(nextPendingStageIndex(a.stages)).toBe(1);
		const b = advanceFollowupStages(a.stages, now);
		expect(b.nextDueAt?.toISOString()).toBe("2026-11-11T12:00:00.000Z");
		const c = advanceFollowupStages(b.stages, now);
		expect(c.nextDueAt).toBeNull();
		expect(nextPendingStageIndex(c.stages)).toBe(-1);
		stages = c.stages;
		expect(stages.every((s) => s.firedAt)).toBe(true);
	});

	it("reagenda um aviso pendente e reordena; enviado ou inexistente não muda", () => {
		const out = setFollowupStageAt(three, 0, new Date("2026-11-20T12:00:00.000Z"))!;
		expect(out.map((s) => s.at)).toEqual(["2026-10-30T12:00:00.000Z", "2026-11-11T12:00:00.000Z", "2026-11-20T12:00:00.000Z"]);
		const fired = advanceFollowupStages(three.map((s) => ({ ...s })), new Date()).stages;
		expect(setFollowupStageAt(fired, 0, new Date())).toBeNull();
		expect(setFollowupStageAt(three, 9, new Date())).toBeNull();
	});

	it("normalizeNewStages ordena, tira repetidas e limita a 4", () => {
		const d = (n: number) => new Date(Date.UTC(2026, 9, n, 12));
		expect(normalizeNewStages([d(20), d(15), d(15), d(21), d(22), d(23)]).map((x) => x.getUTCDate())).toEqual([15, 20, 21, 22]);
	});
});
