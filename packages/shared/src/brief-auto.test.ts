import { describe, expect, it } from "vitest";
import {
	BRIEF_AUTO_NOTICE,
	BRIEF_CHECKED_AT_KEY,
	BRIEF_NOTICE_SHOWN_KEY,
	BRIEF_RECHECK_DAYS,
	briefCheckDayKey,
	isBriefCheckDue,
	BRIEF_OPT_OUT_KEY,
	appendAutoBriefNotice,
	canAutoEnableBrief,
	describeBriefSources,
	inferAutoBriefTime,
	mergeServerPolicyKeys,
	parseDailyBriefSchedule,
	readBriefNoticeShown,
	readBriefOptOut,
	readConfiguredQuietHours,
	type BriefSource,
} from "./index.js";

const NOW = new Date("2026-10-27T15:00:00Z"); // 12:00 em São Paulo
const SP = "America/Sao_Paulo";

/** Uma mensagem por dia, `dayOffset` dias antes de NOW, no horário local (SP = UTC-3) dado. */
function dayAt(dayOffset: number, hhmm: string): Date {
	const [h, m] = hhmm.split(":").map(Number) as [number, number];
	const day = new Date(NOW.getTime() - dayOffset * 86_400_000);
	return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h! + 3, m!));
}

describe("inferAutoBriefTime", () => {
	it("sem dados ou poucos dias ativos: 07:30 todo dia", () => {
		const none = inferAutoBriefTime({ userMessageAts: [], now: NOW, timeZone: SP });
		expect(none).toMatchObject({ hour: 7, minute: 30, cron: "30 7 * * *", basis: "default" });
		const four = [1, 2, 3, 4].map((d) => dayAt(d, "10:00"));
		expect(inferAutoBriefTime({ userMessageAts: four, now: NOW, timeZone: SP }).basis).toBe("default");
		expect(parseDailyBriefSchedule(none.cron).ok).toBe(true);
	});

	it("30 min antes da mediana da 1ª mensagem do dia (5+ dias)", () => {
		const ats = [1, 2, 3, 4, 5].map((d) => dayAt(d, "08:40"));
		expect(inferAutoBriefTime({ userMessageAts: ats, now: NOW, timeZone: SP })).toMatchObject({ hour: 8, minute: 10, basis: "activity" });
	});

	it("usa só a primeira mensagem de cada dia e a mediana (ignora o resto do dia)", () => {
		const ats = [
			...[1, 2, 3].map((d) => dayAt(d, "08:00")),
			...[4, 5].map((d) => dayAt(d, "09:30")),
			// mensagens da tarde não mudam nada
			...[1, 2, 3, 4, 5].map((d) => dayAt(d, "15:00")),
		];
		expect(inferAutoBriefTime({ userMessageAts: ats, now: NOW, timeZone: SP })).toMatchObject({ hour: 7, minute: 30 });
	});

	it("prende entre 06:00 e 09:00", () => {
		const early = [1, 2, 3, 4, 5].map((d) => dayAt(d, "05:10"));
		expect(inferAutoBriefTime({ userMessageAts: early, now: NOW, timeZone: SP })).toMatchObject({ hour: 6, minute: 0 });
		const late = [1, 2, 3, 4, 5].map((d) => dayAt(d, "13:00"));
		expect(inferAutoBriefTime({ userMessageAts: late, now: NOW, timeZone: SP })).toMatchObject({ hour: 9, minute: 0 });
	});

	it("ignora mensagens fora dos 14 dias e de madrugada (antes das 04:00)", () => {
		const old = [15, 16, 17, 18, 19, 20].map((d) => dayAt(d, "06:00"));
		expect(inferAutoBriefTime({ userMessageAts: old, now: NOW, timeZone: SP }).basis).toBe("default");
		const night = [1, 2, 3, 4, 5].map((d) => dayAt(d, "01:00"));
		expect(inferAutoBriefTime({ userMessageAts: night, now: NOW, timeZone: SP }).basis).toBe("default");
	});

	it("respeita o fuso: a mesma hora UTC vira outro horário local", () => {
		const ats = [1, 2, 3, 4, 5].map((d) => new Date(Date.UTC(2026, 9, 27 - d, 12, 0))); // 12:00Z
		expect(inferAutoBriefTime({ userMessageAts: ats, now: NOW, timeZone: "Asia/Tokyo" })).toMatchObject({ hour: 9, minute: 0 }); // 21:00 locais, preso em 09:00
		expect(inferAutoBriefTime({ userMessageAts: ats, now: NOW, timeZone: SP })).toMatchObject({ hour: 8, minute: 30 }); // 09:00 locais - 30 min
	});

	it("fuso inválido cai em São Paulo", () => {
		const ats = [1, 2, 3, 4, 5].map((d) => dayAt(d, "08:40"));
		expect(inferAutoBriefTime({ userMessageAts: ats, now: NOW, timeZone: "Marte/Olimpo" })).toMatchObject({ hour: 8, minute: 10 });
	});

	it("silêncio configurado empurra o horário para o fim dele (até 09:00)", () => {
		const ats = [1, 2, 3, 4, 5].map((d) => dayAt(d, "06:40")); // 06:10
		const quiet = { start: "22:00", end: "08:00" };
		expect(inferAutoBriefTime({ userMessageAts: ats, now: NOW, timeZone: SP, quiet })).toMatchObject({ hour: 8, minute: 0 });
		expect(inferAutoBriefTime({ userMessageAts: ats, now: NOW, timeZone: SP, quiet: { start: "22:00", end: "11:00" } })).toMatchObject({ hour: 9, minute: 0 });
		expect(inferAutoBriefTime({ userMessageAts: ats, now: NOW, timeZone: SP, quiet: { start: "23:00", end: "05:00" } })).toMatchObject({ hour: 6, minute: 10 });
	});
});

describe("estado do brief no policyJson", () => {
	it("opt-out e aviso lidos só quando true", () => {
		expect(readBriefOptOut({ [BRIEF_OPT_OUT_KEY]: true })).toBe(true);
		expect(readBriefOptOut({ [BRIEF_OPT_OUT_KEY]: "true" })).toBe(false);
		expect(readBriefOptOut(null)).toBe(false);
		expect(readBriefNoticeShown({ [BRIEF_NOTICE_SHOWN_KEY]: true })).toBe(true);
		expect(readBriefNoticeShown([])).toBe(false);
	});

	it("canAutoEnableBrief: principal, sem opt-out e proativo não desligado de propósito", () => {
		expect(canAutoEnableBrief({ isPrimary: true, policyJson: null })).toBe(true);
		expect(canAutoEnableBrief({ isPrimary: true, policyJson: { proactive: { enabled: true } } })).toBe(true);
		expect(canAutoEnableBrief({ isPrimary: true, policyJson: { proactive: { enabled: false } } })).toBe(false);
		expect(canAutoEnableBrief({ isPrimary: true, policyJson: { [BRIEF_OPT_OUT_KEY]: true } })).toBe(false);
		expect(canAutoEnableBrief({ isPrimary: false, policyJson: null })).toBe(false);
	});

	it("silêncio só conta quando o usuário configurou", () => {
		expect(readConfiguredQuietHours(null)).toBeNull();
		expect(readConfiguredQuietHours({ proactive: { enabled: true } })).toBeNull();
		expect(readConfiguredQuietHours({ proactive: { quietStart: "23:00", quietEnd: "7:30" } })).toEqual({ start: "23:00", end: "07:30" });
	});

	it("aviso: uma linha no fim do brief", () => {
		expect(appendAutoBriefNotice("Hoje: aula às 10h.\n")).toBe(`Hoje: aula às 10h.\n\n${BRIEF_AUTO_NOTICE}`);
		expect(BRIEF_AUTO_NOTICE).toBe("Comecei a te mandar esse resumo toda manhã. Se não quiser, é só dizer.");
	});
});

describe("describeBriefSources (honestidade)", () => {
	const source = (category: BriefSource["category"], over: Partial<BriefSource> = {}): BriefSource => ({ kind: "composio", name: "X", category, readTools: ["t"], ...over });

	it("lista só as categorias conectadas, na ordem do catálogo, e avisa que site fora das fontes não entra", () => {
		const text = describeBriefSources([source("calendar"), source("email"), source("email", { name: "Outlook" })]);
		expect(text).toContain("e-mail e agenda");
		expect(text).not.toMatch(/mensagens|tarefas|AVA/);
		expect(text).toMatch(/não está conectado não entra/);
	});

	it("sem fonte: não promete nada", () => {
		const text = describeBriefSources([]);
		expect(text).toMatch(/nenhuma fonte conectada/);
		expect(text).not.toMatch(/Vou ler/);
	});

	it("fonte sem tool de leitura não conta; login expirado pede reconexão", () => {
		const text = describeBriefSources([source("email", { readTools: [] }), source("calendar", { name: "Google Agenda", readTools: [], needsReconnect: true })]);
		expect(text).toMatch(/nenhuma fonte conectada/);
		expect(text).toContain("Reconecte Google Agenda");
	});
});

describe("mergeServerPolicyKeys", () => {
	const current = { [BRIEF_OPT_OUT_KEY]: true, [BRIEF_NOTICE_SHOWN_KEY]: true, [BRIEF_CHECKED_AT_KEY]: "2026-10-01", proactive: { enabled: true } };
	it("mantém as chaves do servidor da linha e descarta as do cliente", () => {
		expect(mergeServerPolicyKeys({ a: 1, [BRIEF_OPT_OUT_KEY]: false }, current)).toEqual({ a: 1, [BRIEF_OPT_OUT_KEY]: true, [BRIEF_NOTICE_SHOWN_KEY]: true, [BRIEF_CHECKED_AT_KEY]: "2026-10-01" });
	});
	it("null do cliente só zera o que é dele; sem nada do servidor vira null", () => {
		expect(mergeServerPolicyKeys(null, current)).toEqual({ [BRIEF_OPT_OUT_KEY]: true, [BRIEF_NOTICE_SHOWN_KEY]: true, [BRIEF_CHECKED_AT_KEY]: "2026-10-01" });
		expect(mergeServerPolicyKeys(null, { proactive: {} })).toBeNull();
		expect(mergeServerPolicyKeys({ a: 1 }, null)).toEqual({ a: 1 });
	});
});

describe("isBriefCheckDue (bots sem fonte: recheca por semana)", () => {
	const now = new Date("2026-10-27T15:00:00Z");
	it("sem registro, ilegível ou de tipo errado: devida", () => {
		for (const policy of [null, {}, { [BRIEF_CHECKED_AT_KEY]: "ontem" }, { [BRIEF_CHECKED_AT_KEY]: 5 }, { [BRIEF_CHECKED_AT_KEY]: "2026-13-45" }]) expect(isBriefCheckDue(policy, now)).toBe(true);
	});
	it("checado há menos de 7 dias: não; a partir de 7 dias: sim", () => {
		expect(BRIEF_RECHECK_DAYS).toBe(7);
		expect(isBriefCheckDue({ [BRIEF_CHECKED_AT_KEY]: briefCheckDayKey(now) }, now)).toBe(false);
		expect(isBriefCheckDue({ [BRIEF_CHECKED_AT_KEY]: "2026-10-21" }, now)).toBe(false);
		expect(isBriefCheckDue({ [BRIEF_CHECKED_AT_KEY]: "2026-10-20" }, now)).toBe(true);
	});
});
