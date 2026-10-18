import { describe, expect, it } from "vitest";
import {
	DEFAULT_PROACTIVE_SETTINGS,
	checkProactiveGate,
	findDuplicateFollowup,
	findDuplicateRoutine,
	formatFollowupDue,
	isInQuietHours,
	isProactiveActive,
	isReflectionDue,
	localDayWindow,
	nextAllowedTime,
	readProactiveSettings,
	reflectionSlotMinutes,
	resolveFollowupWhen,
	withProactiveSettings,
	type ProactiveSettings,
} from "./proactive.js";

const SP = "America/Sao_Paulo";
// Terça 2026-10-13, 12:00 em São Paulo (UTC-3).
const NOW = new Date("2026-10-13T15:00:00.000Z");

function when(text: string, tz = SP, now = NOW) {
	const result = resolveFollowupWhen(text, now, tz);
	return result.ok ? result.dueAt.toISOString() : `ERRO: ${result.error}`;
}

describe("readProactiveSettings / withProactiveSettings", () => {
	it("usa os padrões sem configuração", () => {
		expect(readProactiveSettings(null)).toEqual(DEFAULT_PROACTIVE_SETTINGS);
		expect(readProactiveSettings({})).toEqual(DEFAULT_PROACTIVE_SETTINGS);
		expect(DEFAULT_PROACTIVE_SETTINGS.enabled).toBe(false);
		expect(DEFAULT_PROACTIVE_SETTINGS.routineMode).toBe("suggest");
		expect(DEFAULT_PROACTIVE_SETTINGS.maxPerDay).toBe(3);
		expect(DEFAULT_PROACTIVE_SETTINGS.quietStart).toBe("22:00");
		expect(DEFAULT_PROACTIVE_SETTINGS.quietEnd).toBe("08:00");
	});

	it("limita valores e ignora campos inválidos", () => {
		const read = readProactiveSettings({
			proactive: { enabled: true, routineMode: "auto", maxPerDay: 99, quietStart: "25:00", quietEnd: "7:30", timezone: "Nope/Zone" },
		});
		expect(read).toMatchObject({ enabled: true, routineMode: "auto", maxPerDay: 10, quietStart: "22:00", quietEnd: "7:30", timezone: SP });
		expect(readProactiveSettings({ proactive: { maxPerDay: 0 } }).maxPerDay).toBe(1);
		expect(readProactiveSettings({ proactive: { routineMode: "xyz" } }).routineMode).toBe("suggest");
	});

	it("mescla sem perder o resto da política", () => {
		const next = withProactiveSettings({ subagentModel: "x/y", proactive: { enabled: true, maxPerDay: 5 } }, { routineMode: "auto" });
		expect(next.subagentModel).toBe("x/y");
		expect(readProactiveSettings(next)).toMatchObject({ enabled: true, maxPerDay: 5, routineMode: "auto" });
	});

	it("só o bot principal fica ativo", () => {
		const policyJson = { proactive: { enabled: true } };
		expect(isProactiveActive({ isPrimary: true, policyJson })).toBe(true);
		expect(isProactiveActive({ isPrimary: false, policyJson })).toBe(false);
		expect(isProactiveActive({ isPrimary: true, policyJson: null })).toBe(false);
	});
});

describe("fuso da conta como padrão do modo proativo", () => {
	it("sem fuso da conta vale o do bot; sem nenhum, São Paulo", () => {
		expect(readProactiveSettings({ proactive: { enabled: true, timezone: "Europe/Lisbon" } }).timezone).toBe("Europe/Lisbon");
		expect(readProactiveSettings({ proactive: { enabled: true } }).timezone).toBe("America/Sao_Paulo");
		expect(readProactiveSettings(undefined).timezone).toBe("America/Sao_Paulo");
	});
	it("com fuso da conta, ele vale (também sem a política do bot)", () => {
		expect(readProactiveSettings({ proactive: { enabled: true, timezone: "Europe/Lisbon" } }, "Asia/Tokyo").timezone).toBe("Asia/Tokyo");
		expect(readProactiveSettings(undefined, "Asia/Tokyo").timezone).toBe("Asia/Tokyo");
	});
	it("fuso da conta inválido ou vazio é ignorado", () => {
		expect(readProactiveSettings({ proactive: { timezone: "Europe/Lisbon" } }, "Marte/X").timezone).toBe("Europe/Lisbon");
		expect(readProactiveSettings({ proactive: { timezone: "Europe/Lisbon" } }, null).timezone).toBe("Europe/Lisbon");
		expect(readProactiveSettings({ proactive: { timezone: "Europe/Lisbon" } }, "").timezone).toBe("Europe/Lisbon");
	});
	it("o horário de silêncio segue o fuso da conta", () => {
		const settings = readProactiveSettings({ proactive: { enabled: true, quietStart: "22:00", quietEnd: "08:00" } }, "America/Sao_Paulo");
		// 23:30 em São Paulo = 02:30Z do dia seguinte: dentro do silêncio.
		expect(isInQuietHours(new Date("2026-10-15T02:30:00Z"), settings)).toBe(true);
		const tokyo = readProactiveSettings({ proactive: { enabled: true, quietStart: "22:00", quietEnd: "08:00" } }, "Asia/Tokyo");
		// O mesmo instante é 11:30 em Tóquio: fora do silêncio.
		expect(isInQuietHours(new Date("2026-10-15T02:30:00Z"), tokyo)).toBe(false);
	});
});

describe("horário de silêncio", () => {
	const settings: ProactiveSettings = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true };

	it("22:00-08:00 cruza a meia-noite", () => {
		expect(isInQuietHours(new Date("2026-10-14T01:30:00Z"), settings)).toBe(true); // 22:30
		expect(isInQuietHours(new Date("2026-10-14T06:00:00Z"), settings)).toBe(true); // 03:00
		expect(isInQuietHours(new Date("2026-10-14T10:59:00Z"), settings)).toBe(true); // 07:59
		expect(isInQuietHours(new Date("2026-10-14T11:00:00Z"), settings)).toBe(false); // 08:00
		expect(isInQuietHours(new Date("2026-10-14T00:59:00Z"), settings)).toBe(false); // 21:59
	});

	it("janela no mesmo dia e janela vazia", () => {
		const day: ProactiveSettings = { ...settings, quietStart: "13:00", quietEnd: "15:00" };
		expect(isInQuietHours(new Date("2026-10-13T17:00:00Z"), day)).toBe(true); // 14:00
		expect(isInQuietHours(new Date("2026-10-13T15:00:00Z"), day)).toBe(false); // 12:00
		expect(isInQuietHours(NOW, { ...settings, quietStart: "08:00", quietEnd: "08:00" })).toBe(false);
	});

	it("adia para o fim do silêncio", () => {
		// 22:30 de terça -> 08:00 de quarta
		expect(nextAllowedTime(new Date("2026-10-14T01:30:00Z"), settings).toISOString()).toBe("2026-10-14T11:00:00.000Z");
		// 03:00 de quarta -> 08:00 do mesmo dia
		expect(nextAllowedTime(new Date("2026-10-14T06:00:00Z"), settings).toISOString()).toBe("2026-10-14T11:00:00.000Z");
		// fora do silêncio: igual
		expect(nextAllowedTime(NOW, settings).toISOString()).toBe(NOW.toISOString());
	});

	it("respeita o fuso do usuário", () => {
		const ny: ProactiveSettings = { ...settings, timezone: "America/New_York" };
		// 15:00Z = 11:00 EDT: fora do silêncio. 03:00Z = 23:00 EDT do dia anterior: dentro.
		expect(isInQuietHours(NOW, ny)).toBe(false);
		expect(isInQuietHours(new Date("2026-10-14T03:00:00Z"), ny)).toBe(true);
		expect(nextAllowedTime(new Date("2026-10-14T03:00:00Z"), ny).toISOString()).toBe("2026-10-14T12:00:00.000Z");
	});
});

describe("checkProactiveGate", () => {
	const settings: ProactiveSettings = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, maxPerDay: 2 };

	it("libera abaixo do teto e fora do silêncio", () => {
		expect(checkProactiveGate({ now: NOW, settings, sentToday: 1 })).toEqual({ allowed: true });
	});

	it("bloqueia no teto diário e informa quando volta (meia-noite local)", () => {
		const gate = checkProactiveGate({ now: NOW, settings, sentToday: 2 });
		expect(gate).toMatchObject({ allowed: false, reason: "daily_cap" });
		if (!gate.allowed) expect(gate.retryAt?.toISOString()).toBe("2026-10-14T03:00:00.000Z");
	});

	it("silêncio vence e informa o fim da janela", () => {
		const gate = checkProactiveGate({ now: new Date("2026-10-14T02:00:00Z"), settings, sentToday: 0 });
		expect(gate).toMatchObject({ allowed: false, reason: "quiet_hours" });
		if (!gate.allowed) expect(gate.retryAt?.toISOString()).toBe("2026-10-14T11:00:00.000Z");
	});
});

describe("localDayWindow", () => {
	it("delimita o dia no fuso do usuário", () => {
		const w = localDayWindow(new Date("2026-10-14T01:30:00Z"), SP); // ainda dia 13 em SP
		expect(w.start.toISOString()).toBe("2026-10-13T03:00:00.000Z");
		expect(w.end.toISOString()).toBe("2026-10-14T03:00:00.000Z");
	});
});

describe("isReflectionDue", () => {
	const settings: ProactiveSettings = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true };

	it("slot fica logo depois do fim do silêncio, estável por bot", () => {
		const slot = reflectionSlotMinutes(settings, "bot-1");
		expect(slot).toBeGreaterThanOrEqual(8 * 60 + 5);
		expect(slot).toBeLessThanOrEqual(8 * 60 + 30);
		expect(reflectionSlotMinutes(settings, "bot-1")).toBe(slot);
	});

	it("roda uma vez por dia local, depois do slot e fora do silêncio", () => {
		const base = { settings, botId: "bot-1" };
		expect(isReflectionDue({ ...base, now: NOW, lastReflectionAt: null })).toBe(true);
		expect(isReflectionDue({ ...base, now: NOW, lastReflectionAt: new Date("2026-10-13T11:30:00Z") })).toBe(false);
		expect(isReflectionDue({ ...base, now: NOW, lastReflectionAt: new Date("2026-10-12T11:30:00Z") })).toBe(true);
		// 07:00 em SP: antes do slot (e dentro do silêncio)
		expect(isReflectionDue({ ...base, now: new Date("2026-10-13T10:00:00Z"), lastReflectionAt: null })).toBe(false);
		// 08:01: fora do silêncio mas antes do slot (08:05+)
		expect(isReflectionDue({ ...base, now: new Date("2026-10-13T11:01:00Z"), lastReflectionAt: null })).toBe(false);
		expect(isReflectionDue({ ...base, settings: { ...settings, enabled: false }, now: NOW, lastReflectionAt: null })).toBe(false);
	});
});

describe("resolveFollowupWhen", () => {
	it("amanhã com e sem hora", () => {
		expect(when("amanhã 9h")).toBe("2026-10-14T12:00:00.000Z");
		expect(when("amanhã às 18:30")).toBe("2026-10-14T21:30:00.000Z");
		expect(when("Amanhã")).toBe("2026-10-14T12:00:00.000Z"); // 09:00 padrão
		expect(when("depois de amanhã 14h")).toBe("2026-10-15T17:00:00.000Z");
		expect(when("amanhã de manhã")).toBe("2026-10-14T12:00:00.000Z");
		expect(when("amanhã 3 da tarde")).toBe("2026-10-14T18:00:00.000Z");
	});

	it("relativo: daqui a N", () => {
		expect(when("daqui a 2 horas")).toBe("2026-10-13T17:00:00.000Z");
		expect(when("em 30 minutos")).toBe("2026-10-13T15:30:00.000Z");
		expect(when("daqui a meia hora")).toBe("2026-10-13T15:30:00.000Z");
		expect(when("daqui a 3 dias")).toBe("2026-10-16T15:00:00.000Z");
		expect(when("daqui a 2 dias às 9h")).toBe("2026-10-15T12:00:00.000Z");
		expect(when("em uma semana")).toBe("2026-10-20T15:00:00.000Z");
	});

	it("dia da semana: próxima ocorrência", () => {
		expect(when("segunda às 8h")).toBe("2026-10-19T11:00:00.000Z");
		expect(when("sexta-feira 17h")).toBe("2026-10-16T20:00:00.000Z");
		// hoje é terça 12:00: terça às 18h é hoje; terça às 8h é na semana que vem
		expect(when("terça 18h")).toBe("2026-10-13T21:00:00.000Z");
		expect(when("terça 8h")).toBe("2026-10-20T11:00:00.000Z");
		expect(when("semana que vem")).toBe("2026-10-20T12:00:00.000Z");
	});

	it("dia do mês e data", () => {
		expect(when("dia 13 às 18h")).toBe("2026-10-13T21:00:00.000Z");
		expect(when("dia 13")).toBe("2026-11-13T12:00:00.000Z"); // 09:00 de hoje já passou
		expect(when("dia 20")).toBe("2026-10-20T12:00:00.000Z");
		expect(when("dia 31", SP, new Date("2026-11-05T15:00:00Z"))).toBe("2026-12-31T12:00:00.000Z"); // novembro tem 30
		expect(when("20/10 10h")).toBe("2026-10-20T13:00:00.000Z");
		expect(when("05/10")).toBe("2027-10-05T12:00:00.000Z"); // já passou: ano que vem
	});

	it("hoje e hora solta", () => {
		expect(when("hoje 18h")).toBe("2026-10-13T21:00:00.000Z");
		expect(when("18h")).toBe("2026-10-13T21:00:00.000Z");
		expect(when("9h")).toBe("2026-10-14T12:00:00.000Z"); // 09:00 já passou: amanhã
		expect(when("hoje")).toMatch(/^ERRO/);
		expect(when("hoje 9h")).toMatch(/passou/);
	});

	it("ISO: com fuso explícito vale, sem fuso usa o do usuário", () => {
		expect(when("2026-10-14T09:00")).toBe("2026-10-14T12:00:00.000Z");
		expect(when("2026-10-14T09:00", "America/New_York")).toBe("2026-10-14T13:00:00.000Z");
		expect(when("2026-10-14T09:00:00Z")).toBe("2026-10-14T09:00:00.000Z");
		expect(when("2026-10-14T09:00:00-05:00")).toBe("2026-10-14T14:00:00.000Z");
		expect(when("2026-10-14")).toBe("2026-10-14T12:00:00.000Z");
	});

	it("fuso do usuário muda o resultado de 'amanhã 9h'", () => {
		// 15:00Z já é 00:00 de 14/10 em Tóquio: amanhã = 15/10.
		expect(when("amanhã 9h", "Asia/Tokyo")).toBe("2026-10-15T00:00:00.000Z");
		expect(when("amanhã 9h", "America/New_York")).toBe("2026-10-14T13:00:00.000Z");
	});

	it("rejeita vazio, passado, longe demais e texto solto", () => {
		expect(when("")).toMatch(/^ERRO/);
		expect(when("2026-10-01T09:00")).toMatch(/futuro/);
		expect(when("2028-01-01T09:00")).toMatch(/1 ano/);
		expect(when("quando der")).toMatch(/não entendi/);
	});
});

describe("formatFollowupDue", () => {
	it("mostra data e hora no fuso", () => {
		expect(formatFollowupDue(new Date("2026-10-14T12:00:00Z"), SP)).toMatch(/14\/10 às 09:00/);
	});
});

describe("dedupe", () => {
	const existing = [
		{ name: "Resumo da manhã", prompt: "Resuma meus e-mails importantes", schedule: "0 8 * * 1-5" },
		{ name: "Backup semanal", prompt: "Faça o backup do projeto", schedule: "0 20 * * 5" },
	];

	it("mesmo nome (sem acento/caixa) é duplicado", () => {
		expect(findDuplicateRoutine(existing, { name: "resumo da manha" })?.name).toBe("Resumo da manhã");
	});

	it("mesma agenda com tema parecido é duplicado; agenda igual com tema diferente, não", () => {
		expect(
			findDuplicateRoutine(existing, { name: "E-mails importantes", prompt: "Resuma meus e-mails importantes de manhã", schedule: "0 8 * * 1-5" }),
		).not.toBeNull();
		expect(findDuplicateRoutine(existing, { name: "Treino", prompt: "Lembrar de treinar", schedule: "0 8 * * 1-5" })).toBeNull();
	});

	it("lembretes iguais no mesmo horário", () => {
		const pending = [{ note: "Lembrar de pagar o boleto da internet", dueAt: new Date("2026-10-14T12:00:00Z") }];
		expect(findDuplicateFollowup(pending, { note: "lembrar de pagar o boleto da internet", dueAt: new Date("2026-10-14T13:00:00Z") })).not.toBeNull();
		expect(findDuplicateFollowup(pending, { note: "Lembrar de pagar o boleto da internet", dueAt: new Date("2026-10-20T12:00:00Z") })).toBeNull();
		expect(findDuplicateFollowup(pending, { note: "Ligar para o dentista", dueAt: new Date("2026-10-14T12:00:00Z") })).toBeNull();
	});
});
