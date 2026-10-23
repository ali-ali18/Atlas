import { describe, expect, it } from "vitest";
import { ALERT_BACKOFF_AFTER, ALERT_MAX_INTERVAL_MINUTES, ALERT_MIN_INTERVAL_MINUTES, describeAlertCron, planAlertBackoff, validateAlertInterval } from "./routine-alert-schedule.js";
import { describeRoutineAlertSentence } from "./routine-alert.js";

describe("validateAlertInterval", () => {
	it("recusa intervalo curto sem pedido explícito, aceita >= 2 h ou pedido explícito", () => {
		expect(validateAlertInterval(30, false)).toMatch(/under 120 minutes/);
		expect(validateAlertInterval(119, false)).not.toBeNull();
		expect(validateAlertInterval(ALERT_MIN_INTERVAL_MINUTES, false)).toBeNull();
		expect(validateAlertInterval(15, true)).toBeNull();
	});
});

describe("describeAlertCron", () => {
	it("horários em dias úteis e todo dia, em pt-BR simples", () => {
		expect(describeAlertCron("0 10,14,17 * * 1-5")).toBe("em dias úteis às 10h, 14h e 17h");
		expect(describeAlertCron("0 17 * * *")).toBe("todo dia às 17h");
		expect(describeAlertCron("30 9 * * 1-5")).toBe("em dias úteis às 9h30");
		expect(describeAlertCron("0 9 * * 1,3")).toBe("toda segunda e quarta às 9h");
		expect(describeAlertCron("0 9-17/2 * * 1-5")).toBe("em dias úteis, a cada 2 h, das 9h às 17h");
	});
	it("devolve null para o que não sabe descrever", () => {
		expect(describeAlertCron("*/5 * * * *")).toBeNull();
		expect(describeAlertCron("0 9 1 * *")).toBeNull();
		expect(describeAlertCron(null)).toBeNull();
		expect(describeAlertCron("lixo")).toBeNull();
	});
	it("a frase do alerta usa os horários, nunca o cron cru", () => {
		const alert = { condition: "o estoque de canela cair abaixo de 10" };
		expect(describeRoutineAlertSentence({ alert, triggerType: "cron", schedule: "0 10,14,17 * * 1-5" })).toBe("Alerta · confere em dias úteis às 10h, 14h e 17h · avisa se o estoque de canela cair abaixo de 10");
	});
});

describe("planAlertBackoff", () => {
	const quiet = { transition: "quiet" as const };
	const verdict = { triggered: false, summary: "Canela: 25 un." };
	let alert: Parameters<typeof planAlertBackoff>[0]["alert"] = { lastSummary: verdict.summary };
	const step = (every: number, decision: Parameters<typeof planAlertBackoff>[0]["decision"] = quiet, v = verdict) => {
		const plan = planAlertBackoff({ everyMinutes: every, alert, decision, verdict: v });
		alert = { lastSummary: v.summary, quietStreak: plan.quietStreak, ...(plan.backoff ? { backoff: plan.backoff } : {}) };
		return plan;
	};

	it("espaça (x2) depois de N conferências tranquilas e iguais, até 1 vez por dia", () => {
		alert = { lastSummary: verdict.summary };
		let every = 120;
		for (let i = 1; i < ALERT_BACKOFF_AFTER; i += 1) expect(step(every).everyMinutes).toBe(120);
		let plan = step(every);
		expect(plan).toMatchObject({ everyMinutes: 240, quietStreak: 0, backoff: { base: 120, to: 240 } });
		every = plan.everyMinutes;
		for (let i = 0; i < ALERT_BACKOFF_AFTER; i += 1) plan = step(every);
		expect(plan).toMatchObject({ everyMinutes: 480, backoff: { base: 120, to: 480 } });
		every = 1000;
		alert = { lastSummary: verdict.summary, quietStreak: 2, backoff: { base: 120, to: 1000 } };
		expect(step(every).everyMinutes).toBe(ALERT_MAX_INTERVAL_MINUTES);
		every = ALERT_MAX_INTERVAL_MINUTES;
		alert = { lastSummary: verdict.summary, quietStreak: 2, backoff: { base: 120, to: 1440 } };
		expect(step(every).everyMinutes).toBe(ALERT_MAX_INTERVAL_MINUTES);
	});

	it("valor diferente reinicia a contagem sem espaçar", () => {
		alert = { lastSummary: "Canela: 25 un.", quietStreak: 2 };
		const plan = step(120, quiet, { triggered: false, summary: "Canela: 18 un." });
		expect(plan).toMatchObject({ everyMinutes: 120, quietStreak: 1 });
	});

	it("dispara, continua em alerta ou volta ao normal: volta ao intervalo original", () => {
		for (const transition of ["triggered", "still", "reset"] as const) {
			alert = { quietStreak: 1, backoff: { base: 120, to: 480 } };
			expect(planAlertBackoff({ everyMinutes: 480, alert, decision: { transition }, verdict })).toEqual({ everyMinutes: 120, quietStreak: 0, backoff: null });
		}
	});

	it("sem veredito não mexe; intervalo editado por fora vira o novo original", () => {
		alert = { quietStreak: 2, backoff: { base: 120, to: 480 } };
		expect(planAlertBackoff({ everyMinutes: 480, alert, decision: { transition: "inconclusive" }, verdict: null })).toEqual({ everyMinutes: 480, quietStreak: 2, backoff: { base: 120, to: 480 } });
		const edited = planAlertBackoff({ everyMinutes: 180, alert, decision: { transition: "triggered" }, verdict });
		expect(edited.everyMinutes).toBe(180);
	});
});
