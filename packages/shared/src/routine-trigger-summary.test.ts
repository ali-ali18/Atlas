import { describe, expect, it } from "vitest";
import { describeRoutineTrigger, routineNextRunAt } from "./routine-trigger-summary.js";
import { describeEmailTrigger } from "./routine-email.js";

const base = { schedule: null, timezone: "America/Sao_Paulo" } as const;

describe("describeRoutineTrigger", () => {
	it("uma vez, intervalo e cron viram frase", () => {
		expect(describeRoutineTrigger({ ...base, triggerType: "once", once: { runAt: "2026-10-03T13:00:00.000Z" } })).toBe("Uma vez · 03/10 às 10:00");
		expect(describeRoutineTrigger({ ...base, triggerType: "interval", interval: { everyMinutes: 50 } })).toBe("A cada 50 min");
		expect(describeRoutineTrigger({ ...base, triggerType: "interval", interval: { everyMinutes: 120 } })).toBe("A cada 2 h");
		expect(describeRoutineTrigger({ ...base, triggerType: "cron", schedule: "0 8 * * *" })).toBe("todo dia às 8h");
		expect(describeRoutineTrigger({ ...base, triggerType: "cron", schedule: "0 8 * * 1-5" })).toBe("nos dias úteis às 8h");
	});

	it("evento: e-mail e webhook; a chave do webhook só aparece quando pedida", () => {
		const email = { fromContains: "banco" };
		expect(describeRoutineTrigger({ ...base, triggerType: "event", email })).toBe(`e-mail (${describeEmailTrigger(email)})`);
		const hook = { hookKey: "hk_123", url: "https://x.test/hook" };
		expect(describeRoutineTrigger({ ...base, triggerType: "event", hook })).toBe("webhook");
		expect(describeRoutineTrigger({ ...base, triggerType: "event", hook }, { hookKey: true })).toBe("webhook · hk_123");
		expect(describeRoutineTrigger({ ...base, triggerType: "event" })).toBe("webhook");
	});

	it("dado inválido não lança", () => {
		expect(describeRoutineTrigger({ ...base, triggerType: "once" })).toBe("Uma vez · —");
		expect(describeRoutineTrigger({ ...base, triggerType: "interval" })).toBe("A cada —");
	});
});

describe("routineNextRunAt", () => {
	const now = new Date("2026-10-01T12:00:00.000Z");
	const common = { enabled: true, createdAt: "2026-10-01T00:00:00.000Z", lastRunAt: null } as const;

	it("once: o horário marcado, só se ainda não passou", () => {
		expect(routineNextRunAt({ ...common, triggerType: "once", once: { runAt: "2026-10-03T13:00:00.000Z" } }, now)).toBe("2026-10-03T13:00:00.000Z");
		expect(routineNextRunAt({ ...common, triggerType: "once", once: { runAt: "2026-09-30T13:00:00.000Z" } }, now)).toBeNull();
		expect(routineNextRunAt({ ...common, triggerType: "once", once: { runAt: "lixo" } }, now)).toBeNull();
	});

	it("interval: última execução (ou criação) mais o intervalo; já vencido ou intervalo inválido = null", () => {
		expect(routineNextRunAt({ ...common, triggerType: "interval", interval: { everyMinutes: 60 }, lastRunAt: "2026-10-01T11:30:00.000Z" }, now)).toBe("2026-10-01T12:30:00.000Z");
		expect(routineNextRunAt({ ...common, triggerType: "interval", interval: { everyMinutes: 1440 } }, now)).toBe("2026-10-02T00:00:00.000Z");
		expect(routineNextRunAt({ ...common, triggerType: "interval", interval: { everyMinutes: 30 }, lastRunAt: "2026-10-01T10:00:00.000Z" }, now)).toBeNull();
		expect(routineNextRunAt({ ...common, triggerType: "interval", interval: { everyMinutes: 0 } }, now)).toBeNull();
	});

	it("pausada, cron e evento não têm próxima execução calculada", () => {
		expect(routineNextRunAt({ ...common, enabled: false, triggerType: "once", once: { runAt: "2026-10-03T13:00:00.000Z" } }, now)).toBeNull();
		expect(routineNextRunAt({ ...common, triggerType: "cron" }, now)).toBeNull();
		expect(routineNextRunAt({ ...common, triggerType: "event" }, now)).toBeNull();
	});
});
