import { describe, expect, it } from "vitest";
import {
	BLOCK_STEPS,
	CHAT_BUDGET,
	LONG_WORK_BUDGET,
	MAX_STEPS_SAFETY,
	WRAP_UP_NOTE,
	budgetForProfile,
	createSupervisor,
} from "./supervisor.js";

const budget = { maxCostUsd: 1, maxActiveMs: 10 * 60_000 };
const usage = (costUsd: number, activeMs = 0, step = 0) => ({ costUsd, activeMs, step });
const record = (over: Partial<Parameters<ReturnType<typeof createSupervisor>["recordTool"]>[0]> = {}) => ({
	step: 1,
	name: "web_search",
	argsKey: "q=a",
	resultKey: "r1",
	ok: true,
	...over,
});

describe("orçamento por perfil", () => {
	it("trabalho longo = US$ 0,50 e 20 min; chat é menor", () => {
		expect(budgetForProfile("long_work")).toEqual(LONG_WORK_BUDGET);
		expect(LONG_WORK_BUDGET).toEqual({ maxCostUsd: 0.5, maxActiveMs: 20 * 60_000 });
		expect(budgetForProfile("chat")).toEqual(CHAT_BUDGET);
		expect(CHAT_BUDGET.maxCostUsd).toBeLessThan(LONG_WORK_BUDGET.maxCostUsd);
		expect(CHAT_BUDGET.maxActiveMs).toBeLessThan(LONG_WORK_BUDGET.maxActiveMs);
	});

	it("o bot ajusta o trabalho longo, mas o teto de custo da conta vence", () => {
		expect(budgetForProfile("long_work", { longWorkBudgetUsd: 2, longWorkMinutes: 45 })).toEqual({ maxCostUsd: 2, maxActiveMs: 45 * 60_000 });
		expect(budgetForProfile("long_work", { longWorkBudgetUsd: 2, accountCapUsd: 0.8 }).maxCostUsd).toBe(0.8);
		// O ajuste de trabalho longo não mexe no chat.
		expect(budgetForProfile("chat", { longWorkBudgetUsd: 5, longWorkMinutes: 90 })).toEqual(CHAT_BUDGET);
	});
});

describe("gate: aviso e entrega", () => {
	it("abaixo de 80% segue sem nota", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		expect(supervisor.gate(usage(0.5, 60_000))).toEqual({ action: "call" });
	});

	it("avisa UMA vez a 80% (por custo ou por tempo) e depois só segue", () => {
		const byCost = createSupervisor({ profile: "long_work", budget });
		expect(byCost.gate(usage(0.8))).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(byCost.gate(usage(0.9))).toEqual({ action: "call" });
		expect(byCost.gate(usage(0.95))).toEqual({ action: "call" });

		const byTime = createSupervisor({ profile: "long_work", budget });
		expect(byTime.gate(usage(0, 8 * 60_000))).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(byTime.gate(usage(0, 9 * 60_000))).toEqual({ action: "call" });
	});

	it("ao estourar o custo faz a última chamada sem tools (entrega), nunca aborta", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		const gate = supervisor.gate(usage(1.02, 1000, 12));
		expect(gate.action).toBe("deliver");
		if (gate.action !== "deliver") return;
		expect(gate.stop).toEqual({ reason: "budget_cost", detail: "delivered" });
		expect(gate.instruction).toMatch(/Do not call any tools/);
		expect(gate.instruction).toMatch(/could not confirm/);
	});

	it("ao estourar o tempo entrega com budget_wall; custo e tempo juntos vence o maior", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		const wall = supervisor.gate(usage(0.2, 10 * 60_000 + 1));
		expect(wall.action === "deliver" && wall.stop.reason).toBe("budget_wall");
		const both = createSupervisor({ profile: "long_work", budget }).gate(usage(1.5, 10 * 60_000 + 1));
		expect(both.action === "deliver" && both.stop.reason).toBe("budget_cost");
	});

	it("teto absoluto de passos só como segurança (alto)", () => {
		expect(MAX_STEPS_SAFETY).toBeGreaterThanOrEqual(150);
		const supervisor = createSupervisor({ profile: "long_work", budget });
		expect(supervisor.gate(usage(0.01, 1000, MAX_STEPS_SAFETY - 1)).action).toBe("call");
		const gate = supervisor.gate(usage(0.01, 1000, MAX_STEPS_SAFETY));
		expect(gate.action === "deliver" && gate.stop.reason).toBe("budget_steps");
	});

	it("custo desconhecido (0) não dispara nada; o tempo continua valendo", () => {
		const supervisor = createSupervisor({ profile: "chat", budget });
		expect(supervisor.gate(usage(0, 1000)).action).toBe("call");
	});
});

describe("repetição real", () => {
	it("3 iguais seguidas = nota (sem abortar); só aborta se repetir de novo depois da nota", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		expect(supervisor.recordTool(record({ step: 1 }))).toEqual({ notes: [] });
		expect(supervisor.recordTool(record({ step: 2 }))).toEqual({ notes: [] });
		const third = supervisor.recordTool(record({ step: 3 }));
		expect(third.abort).toBeUndefined();
		expect(third.notes).toHaveLength(1);
		expect(third.notes[0]).toMatch(/same arguments and got the same result/);
		const fourth = supervisor.recordTool(record({ step: 4 }));
		expect(fourth.abort).toEqual({ reason: "loop_repeat", detail: "after_note" });
	});

	it("uma chamada diferente no meio zera a sequência", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		supervisor.recordTool(record());
		supervisor.recordTool(record());
		supervisor.recordTool(record({ argsKey: "q=b" }));
		expect(supervisor.recordTool(record())).toEqual({ notes: [] });
		expect(supervisor.recordTool(record())).toEqual({ notes: [] });
	});

	it("mesmos args com resultado diferente (leitura que muda) não é travamento", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		for (let i = 0; i < 10; i += 1) {
			expect(supervisor.recordTool(record({ step: i, resultKey: `r${i}` }))).toEqual({ notes: [] });
		}
	});

	it("15 leituras diferentes seguidas nunca disparam nada (diferença central para o v1)", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		for (let i = 0; i < 15; i += 1) {
			expect(supervisor.recordTool(record({ step: i, name: "web_extract", argsKey: `url${i}`, resultKey: `page${i}` }))).toEqual({ notes: [] });
		}
	});
});

describe("falhas da mesma tool", () => {
	it("3 falhas seguidas = nota e bloqueio temporário; o run não morre", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		const fail = (step: number) => supervisor.recordTool(record({ step, ok: false, argsKey: `a${step}`, resultKey: `e${step}`, message: "timeout" }));
		expect(fail(1).notes).toEqual([]);
		expect(fail(2).notes).toEqual([]);
		const third = fail(3);
		expect(third.abort).toBeUndefined();
		expect(third.notes[0]).toMatch(/failed 3 times in a row/);
		expect(supervisor.toolBlocked("web_search", 4)).toMatch(/temporarily unavailable/);
		expect(supervisor.toolBlocked("web_extract", 4)).toBeUndefined();
	});

	it("o bloqueio expira depois de alguns passos e a contagem recomeça", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		for (let step = 1; step <= 3; step += 1) supervisor.recordTool(record({ step, ok: false, argsKey: `a${step}`, resultKey: `e${step}` }));
		expect(supervisor.toolBlocked("web_search", 3 + BLOCK_STEPS)).toBeDefined();
		expect(supervisor.toolBlocked("web_search", 3 + 1 + BLOCK_STEPS)).toBeUndefined();
		expect(supervisor.recordTool(record({ step: 10, ok: false, argsKey: "z", resultKey: "z" })).notes).toEqual([]);
	});

	it("um sucesso no meio zera as falhas; falhas de tools diferentes não somam", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		supervisor.recordTool(record({ step: 1, ok: false, argsKey: "1", resultKey: "1" }));
		supervisor.recordTool(record({ step: 2, ok: false, argsKey: "2", resultKey: "2" }));
		supervisor.recordTool(record({ step: 3, ok: true, argsKey: "3", resultKey: "3" }));
		supervisor.recordTool(record({ step: 4, ok: false, argsKey: "4", resultKey: "4" }));
		expect(supervisor.toolBlocked("web_search", 5)).toBeUndefined();
		const other = createSupervisor({ profile: "long_work", budget });
		for (const [i, name] of ["a", "b", "c", "a", "b", "c"].entries()) other.recordTool(record({ step: i, name, ok: false, argsKey: `${i}`, resultKey: `${i}` }));
		for (const name of ["a", "b", "c"]) expect(other.toolBlocked(name, 7)).toBeUndefined();
	});
});
