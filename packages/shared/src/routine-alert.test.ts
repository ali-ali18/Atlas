import { describe, expect, it } from "vitest";
import {
	alertConditionPhrase,
	alertSupportsTrigger,
	applyAlertConfig,
	buildAlertRunText,
	decideAlertNotification,
	describeRoutineAlertSentence,
	formatRoutineAlertSentence,
	nextAlertState,
	parseAlertVerdict,
	parseRoutineAlert,
	parseRoutineAlertInput,
} from "./index.js";

describe("parseRoutineAlertInput", () => {
	it("aceita condição e dica, normalizando espaços", () => {
		const result = parseRoutineAlertInput({ condition: "  o estoque da   canela cair abaixo de 10 ", hint: " produto: canela " });
		expect(result).toEqual({ ok: true, alert: { condition: "o estoque da canela cair abaixo de 10", hint: "produto: canela" } });
	});

	it("alert.rule.expect sai ao lado do alerta e não é gravado nele; expect inválido recusa", () => {
		const rule = { source: { type: "page", url: "https://loja.example.com/p", extract: { kind: "css", selector: "span.price" } }, check: { kind: "value", parse: "money", op: "lt", value: 400 }, expect: "R$ 449,90" };
		const result = parseRoutineAlertInput({ rule });
		expect(result).toMatchObject({ ok: true, expect: "R$ 449,90" });
		if (result.ok) expect(JSON.stringify(result.alert)).not.toContain("expect");
		expect(parseRoutineAlertInput({ rule: { ...rule, expect: "" } })).toMatchObject({ ok: false, error: expect.stringContaining("rule.expect") });
		expect("expect" in (parseRoutineAlertInput({ rule: { ...rule, expect: undefined } }) as object)).toBe(false);
	});

	it("rejeita vazio, curto demais, longo demais e tipos errados", () => {
		expect(parseRoutineAlertInput(null).ok).toBe(false);
		expect(parseRoutineAlertInput("estoque").ok).toBe(false);
		expect(parseRoutineAlertInput({ condition: "  " }).ok).toBe(false);
		expect(parseRoutineAlertInput({ condition: "ab" }).ok).toBe(false);
		expect(parseRoutineAlertInput({ condition: "x".repeat(301) }).ok).toBe(false);
		expect(parseRoutineAlertInput({ condition: "estoque baixo", hint: 5 }).ok).toBe(false);
		expect(parseRoutineAlertInput({ condition: "estoque baixo", hint: "y".repeat(301) }).ok).toBe(false);
	});

	it("aceita o limite máximo", () => {
		expect(parseRoutineAlertInput({ condition: "x".repeat(300) }).ok).toBe(true);
	});
});

describe("alertSupportsTrigger", () => {
	it("só cron e intervalo verificam de tempos em tempos", () => {
		expect(alertSupportsTrigger("cron")).toBe(true);
		expect(alertSupportsTrigger("interval")).toBe(true);
		expect(alertSupportsTrigger("once")).toBe(false);
		expect(alertSupportsTrigger("event")).toBe(false);
	});
});

describe("parseRoutineAlert", () => {
	it("lê o estado guardado e ignora lixo", () => {
		expect(parseRoutineAlert({ condition: "estoque < 10", active: true, triggeredAt: "2026-10-01T10:00:00.000Z" })).toEqual({
			condition: "estoque < 10",
			active: true,
			triggeredAt: "2026-10-01T10:00:00.000Z",
		});
		expect(parseRoutineAlert(null)).toBeNull();
		expect(parseRoutineAlert([])).toBeNull();
		expect(parseRoutineAlert({ active: true })).toBeNull();
		expect(parseRoutineAlert({ condition: "estoque baixo" })?.active).toBe(false);
	});
});

describe("applyAlertConfig", () => {
	const previous = { condition: "estoque < 10", active: true, triggeredAt: "2026-10-01T10:00:00.000Z", hint: "canela" };

	it("mesma condição mantém o estado (editar a dica não rearma)", () => {
		expect(applyAlertConfig(previous, { condition: "estoque < 10" })).toEqual({ condition: "estoque < 10", active: true, triggeredAt: previous.triggeredAt });
	});

	it("condição nova começa de fora, pronta para avisar", () => {
		expect(applyAlertConfig(previous, { condition: "estoque < 5", hint: "x" })).toEqual({ condition: "estoque < 5", hint: "x", active: false });
		expect(applyAlertConfig(null, { condition: "venda < meta" })).toEqual({ condition: "venda < meta", active: false });
	});
});

describe("parseAlertVerdict", () => {
	it("exige boolean e resumo", () => {
		expect(parseAlertVerdict({ triggered: true, summary: " Estoque de canela: 7 un. " })).toEqual({ ok: true, verdict: { triggered: true, summary: "Estoque de canela: 7 un." } });
		expect(parseAlertVerdict({ triggered: "true", summary: "x" }).ok).toBe(false);
		expect(parseAlertVerdict({ triggered: false, summary: "  " }).ok).toBe(false);
		expect(parseAlertVerdict(undefined).ok).toBe(false);
	});

	it("corta resumo enorme", () => {
		const result = parseAlertVerdict({ triggered: false, summary: "a".repeat(500) });
		expect(result.ok && result.verdict.summary.length).toBe(300);
	});
});

describe("decideAlertNotification (debounce)", () => {
	const yes = { triggered: true, summary: "7 un." };
	const no = { triggered: false, summary: "25 un." };

	it("avisa só na virada de falso para verdadeiro", () => {
		expect(decideAlertNotification({ wasActive: false, verdict: yes })).toEqual({ transition: "triggered", notify: true, active: true, unverified: false });
	});

	it("não avisa de novo enquanto a condição continua verdadeira", () => {
		expect(decideAlertNotification({ wasActive: true, verdict: yes })).toEqual({ transition: "still", notify: false, active: true, unverified: false });
	});

	it("rearma quando a condição deixa de valer e avisa de novo na próxima virada", () => {
		const reset = decideAlertNotification({ wasActive: true, verdict: no });
		expect(reset).toEqual({ transition: "reset", notify: false, active: false, unverified: false });
		expect(decideAlertNotification({ wasActive: reset.active, verdict: yes }).notify).toBe(true);
	});

	it("falso continuando falso é silêncio", () => {
		expect(decideAlertNotification({ wasActive: false, verdict: no })).toEqual({ transition: "quiet", notify: false, active: false, unverified: false });
	});

	it("sem veredito não muda o 'em alerta'; avisa que não verificou só na primeira vez seguida", () => {
		expect(decideAlertNotification({ wasActive: true, verdict: null })).toEqual({ transition: "inconclusive", notify: true, active: true, unverified: true });
		expect(decideAlertNotification({ wasActive: false, verdict: null }).active).toBe(false);
		expect(decideAlertNotification({ wasActive: false, wasUnverified: true, verdict: null }).notify).toBe(false);
	});

	it("a primeira verificação conclusiva depois de falhar rearma o aviso de falha", () => {
		const now = new Date("2026-10-02T12:00:00.000Z");
		const failed = nextAlertState({ condition: "estoque baixo", active: false }, decideAlertNotification({ wasActive: false, verdict: null }), null, now);
		expect(failed.unverified).toBe(true);
		const ok = { triggered: false, summary: "25 un." };
		const recovered = nextAlertState(failed, decideAlertNotification({ wasActive: false, wasUnverified: true, verdict: ok }), ok, now);
		expect(recovered.unverified).toBeUndefined();
		expect(decideAlertNotification({ wasActive: false, wasUnverified: recovered.unverified, verdict: null }).notify).toBe(true);
	});
});

describe("nextAlertState / buildAlertRunText", () => {
	const now = new Date("2026-10-02T12:00:00.000Z");
	const base = { condition: "estoque < 10", active: false };

	it("registra a virada com horário e resumo", () => {
		const verdict = { triggered: true, summary: "7 un." };
		const decision = decideAlertNotification({ wasActive: false, verdict });
		expect(nextAlertState(base, decision, verdict, now)).toEqual({ ...base, active: true, checkedAt: now.toISOString(), triggeredAt: now.toISOString(), lastSummary: "7 un." });
	});

	it("verificação sem virada não mexe em triggeredAt", () => {
		const prev = { ...base, active: true, triggeredAt: "2026-10-01T10:00:00.000Z" };
		const verdict = { triggered: true, summary: "6 un." };
		const next = nextAlertState(prev, decideAlertNotification({ wasActive: true, verdict }), verdict, now);
		expect(next.triggeredAt).toBe("2026-10-01T10:00:00.000Z");
		expect(next.checkedAt).toBe(now.toISOString());
	});

	it("sem veredito mantém o 'em alerta' e marca a falha", () => {
		const prev = { ...base, active: true };
		expect(nextAlertState(prev, decideAlertNotification({ wasActive: true, verdict: null }), null, now)).toEqual({ ...prev, checkedAt: now.toISOString(), unverified: true });
	});

	it("texto do resultado por transição", () => {
		const v = { triggered: true, summary: "7 un." };
		const base = { notify: false, unverified: false };
		expect(buildAlertRunText({ ...base, transition: "triggered", notify: true, active: true }, v)).toBe("⚠️ 7 un.");
		expect(buildAlertRunText({ ...base, transition: "still", active: true }, v)).toMatch(/^Continua em alerta/);
		expect(buildAlertRunText({ ...base, transition: "reset", active: false }, v)).toMatch(/^Voltou ao normal/);
		expect(buildAlertRunText({ ...base, transition: "quiet", active: false }, v)).toMatch(/^Tudo certo/);
		const failed = { transition: "inconclusive" as const, notify: true, active: false, unverified: true };
		expect(buildAlertRunText(failed, null)).toBe("⚠️ Não consegui verificar o alerta desta vez.");
		expect(buildAlertRunText(failed, null, { name: "Estoque da canela", reason: "o ERP não respondeu" })).toBe("⚠️ Não consegui verificar o alerta “Estoque da canela”: o ERP não respondeu.");
	});
});

describe("formatRoutineAlertSentence", () => {
	it("monta a frase do card sem cron nem modo interno", () => {
		expect(formatRoutineAlertSentence({ condition: "o estoque da canela cair abaixo de 10" }, "A cada 30 min")).toBe(
			"Alerta · confere a cada 30 min · avisa se o estoque da canela cair abaixo de 10",
		);
		expect(formatRoutineAlertSentence({ condition: "se a venda do dia ficar abaixo da meta" }, "Todo dia às 17:00")).toBe(
			"Alerta · confere todo dia às 17:00 · avisa se a venda do dia ficar abaixo da meta",
		);
	});

	it("lê a cadência do próprio gatilho (intervalo ou horário), nunca o cron cru", () => {
		const alert = { condition: "o estoque da canela cair abaixo de 10" };
		expect(describeRoutineAlertSentence({ alert, triggerType: "interval", interval: { everyMinutes: 30 } })).toBe(
			"Alerta · confere a cada 30 minutos · avisa se o estoque da canela cair abaixo de 10",
		);
		expect(describeRoutineAlertSentence({ alert, triggerType: "interval", interval: { everyMinutes: 120 } })).toContain("a cada 2 horas");
		const cron = describeRoutineAlertSentence({ alert: { condition: "a venda do dia ficar abaixo da meta" }, triggerType: "cron", schedule: "0 17 * * *" });
		expect(cron).toBe("Alerta · confere todo dia às 17h · avisa se a venda do dia ficar abaixo da meta");
		expect(cron).not.toMatch(/\* \*/);
		expect(describeRoutineAlertSentence({ triggerType: "interval", interval: { everyMinutes: 30 } })).toBeNull();
	});

	it("não duplica o 'se' e tolera cadência vazia", () => {
		expect(alertConditionPhrase("Avisar se chegar pedido acima de R$ 5 mil")).toBe("chegar pedido acima de R$ 5 mil");
		expect(formatRoutineAlertSentence({ condition: "chegar pedido acima de R$ 5 mil" }, "")).toContain("confere de tempos em tempos");
	});
});

describe("describeRoutineAlertSentence · cotação (etapa 2)", () => {
	it("diz 'no pregão' na cadência da cotação e não nas outras fontes", async () => {
		const { describeRoutineAlertSentence, parseAlertRule } = await import("./index.js");
		const make = (source: object) => (parseAlertRule({ source, check: { kind: "value", parse: "money", op: "lt", value: 15 } }) as { ok: true; rule: import("./index.js").AlertRule }).rule;
		const sentence = (source: object) => describeRoutineAlertSentence({ alert: { condition: "x", rule: make(source) }, triggerType: "interval", interval: { everyMinutes: 15 } })?.replace(/ /g, " ");
		expect(sentence({ type: "quote", symbol: "BBAS3" })).toMatch(/^Alerta · BBAS3 < R\$ 15,00 · a cada 15 minutos no pregão$/);
		expect(sentence({ type: "crypto", symbol: "BTC" })).not.toContain("pregão");
	});
});
