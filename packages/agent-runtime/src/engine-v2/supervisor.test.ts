import { describe, expect, it } from "vitest";
import {
	BLOCK_STEPS,
	CHAT_BUDGET,
	LONG_WORK_BUDGET,
	MAX_STEPS_SAFETY,
	GAP_ROUND_STEPS,
	RESERVE_GAPS_NOTE,
	RESERVE_WRITE_NOTE,
	STAGNATION_STEPS,
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
	it("trabalho longo: sem teto em US$ e 60 min por padrão (o árbitro é progresso e tempo); chat é menor e tem teto", () => {
		expect(budgetForProfile("long_work")).toEqual(LONG_WORK_BUDGET);
		expect(LONG_WORK_BUDGET).toEqual({ maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: 60 * 60_000 });
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

describe("piso de orçamento (brief e lembrete check)", () => {
	it("o piso sobe o chat, nunca baixa o trabalho longo maior, e os tetos do dono vencem", () => {
		expect(budgetForProfile("chat", { floor: { costUsd: 0.5, minutes: 30 } })).toEqual({ maxCostUsd: 0.5, maxActiveMs: 30 * 60_000 });
		expect(budgetForProfile("long_work", { longWorkBudgetUsd: 2, longWorkMinutes: 45, floor: { costUsd: 0.5, minutes: 30 } })).toEqual({ maxCostUsd: 2, maxActiveMs: 45 * 60_000 });
		expect(budgetForProfile("chat", { floor: { costUsd: 0.5, minutes: 30 }, accountCapUsd: 0.1, accountCapMs: 5 * 60_000 })).toEqual({ maxCostUsd: 0.1, maxActiveMs: 5 * 60_000 });
		expect(budgetForProfile("chat")).toEqual(CHAT_BUDGET);
	});
});

describe("gate: aviso e entrega", () => {
	it("abaixo de 80% segue sem nota", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		expect(supervisor.gate(usage(0.5, 60_000))).toEqual({ action: "call" });
	});

	it("chat: avisa UMA vez a 80% (por custo ou por tempo) e depois só segue", () => {
		const byCost = createSupervisor({ profile: "chat", budget });
		expect(byCost.gate(usage(0.8))).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(byCost.gate(usage(0.9))).toEqual({ action: "call" });

		const byTime = createSupervisor({ profile: "chat", budget });
		expect(byTime.gate(usage(0, 8 * 60_000))).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(byTime.gate(usage(0, 9 * 60_000))).toEqual({ action: "call" });
	});

	it("modelo caro: 40% do tempo e US$ 50 gastos não mudam nada; sem teto em US$ o dinheiro nunca é gatilho", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget: { ...budget, maxCostUsd: Number.POSITIVE_INFINITY } });
		expect(supervisor.gate(usage(50, 4 * 60_000, 20))).toEqual({ action: "call" });
		expect(supervisor.phase()).toBe("research");
		expect(supervisor.researchRemaining(usage(50, 4 * 60_000)).costUsd).toBe(Number.POSITIVE_INFINITY);
	});

	it("gatilho (a): todos os itens da lista concluídos ou descartados encerram a pesquisa, uma vez", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		expect(supervisor.gate(usage(0.1, 1000, 3), { listDone: false })).toEqual({ action: "call" });
		expect(supervisor.gate(usage(0.1, 1000, 4), { listDone: true })).toEqual({ action: "call", note: RESERVE_WRITE_NOTE });
		expect(supervisor.researchEnd()).toBe("list_done");
		expect(supervisor.phase()).toBe("write");
		expect(supervisor.gate(usage(0.1, 1000, 5), { listDone: true })).toEqual({ action: "call" });
	});

	it("gatilho (b): 4 passos seguidos sem caderno novo nem item concluído; progresso zera a contagem", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		const at = (step: number, notebookCount: number, completedCount: number) => supervisor.gate(usage(0.1, 1000, step), { notebookCount, completedCount });
		// Antes do primeiro progresso a estagnação não conta (o modelo ainda está lendo).
		for (let step = 0; step < 6; step += 1) expect(at(step, 0, 0)).toEqual({ action: "call" });
		expect(at(6, 1, 0)).toEqual({ action: "call" });
		// 3 sem progresso, depois progresso: zera.
		for (let step = 7; step < 10; step += 1) expect(at(step, 1, 0)).toEqual({ action: "call" });
		expect(at(10, 2, 0)).toEqual({ action: "call" });
		for (let step = 11; step < STAGNATION_STEPS + 10; step += 1) expect(at(step, 2, 0)).toEqual({ action: "call" });
		expect(at(STAGNATION_STEPS + 10, 2, 0)).toEqual({ action: "call", note: RESERVE_WRITE_NOTE });
		expect(supervisor.researchEnd()).toBe("stagnation");
		// Item concluído da lista também é progresso.
		const other = createSupervisor({ profile: "long_work", budget });
		other.gate(usage(0, 0, 0), { notebookCount: 1, completedCount: 0 });
		for (let step = 1; step < STAGNATION_STEPS; step += 1) other.gate(usage(0, 0, step), { notebookCount: 1, completedCount: 0 });
		expect(other.gate(usage(0, 0, 9), { notebookCount: 1, completedCount: 1 })).toEqual({ action: "call" });
	});

	it("gatilhos (c) e (d): 70% do tempo máximo ou 70% do teto de passos", () => {
		const byTime = createSupervisor({ profile: "long_work", budget });
		expect(byTime.gate(usage(0, 6.9 * 60_000, 1))).toEqual({ action: "call" });
		expect(byTime.gate(usage(0, 7 * 60_000, 2))).toEqual({ action: "call", note: RESERVE_WRITE_NOTE });
		expect(byTime.researchEnd()).toBe("time");
		const bySteps = createSupervisor({ profile: "long_work", budget, maxSteps: 100 });
		expect(bySteps.gate(usage(0, 1000, 69))).toEqual({ action: "call" });
		expect(bySteps.gate(usage(0, 1000, 70))).toEqual({ action: "call", note: RESERVE_WRITE_NOTE });
		expect(bySteps.researchEnd()).toBe("steps");
	});

	it("gatilho (e): com gasto máximo preenchido, 75% do teto em US$ leva à escrita; sem ele o dinheiro não conta", () => {
		const capped = createSupervisor({ profile: "long_work", budget });
		expect(capped.gate(usage(0.74, 1000, 1))).toEqual({ action: "call" });
		expect(capped.gate(usage(0.75, 1000, 2))).toEqual({ action: "call", note: RESERVE_WRITE_NOTE });
		expect(capped.researchEnd()).toBe("cost");
		// No teto de 100% do gasto máximo, entrega (a escrita tem fallback sem teto em US$).
		const hard = createSupervisor({ profile: "long_work", budget }).gate(usage(1.01, 1000, 3));
		expect(hard.action === "deliver" && hard.stop.reason).toBe("budget_cost");
	});

	it("com lacunas a pesquisa termina numa rodada curta (até 4 passos) antes da escrita; sem lacunas vai direto escrever", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		expect(supervisor.gate(usage(0, 7 * 60_000, 1), { gaps: 2 })).toEqual({ action: "call", note: RESERVE_GAPS_NOTE });
		expect(supervisor.phase()).toBe("gaps");
		for (let step = 2; step <= GAP_ROUND_STEPS + 1; step += 1) expect(supervisor.gate(usage(0, 7 * 60_000, step), { gaps: 2 })).toEqual({ action: "call" });
		expect(supervisor.gate(usage(0, 7 * 60_000, 9), { gaps: 2 })).toEqual({ action: "call", note: RESERVE_WRITE_NOTE });
		expect(supervisor.phase()).toBe("write");
		// Lacunas fechadas antes: escreve logo.
		const closed = createSupervisor({ profile: "long_work", budget });
		closed.gate(usage(0, 7 * 60_000, 1), { gaps: 1 });
		expect(closed.gate(usage(0, 7 * 60_000, 2), { gaps: 0 })).toEqual({ action: "call", note: RESERVE_WRITE_NOTE });
	});

	it("pesquisa e ajudantes só gastam o tempo até 70% (e 75% do gasto máximo, se houver); depois da pesquisa, nada", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		expect(supervisor.researchRemaining(usage(0.25, 2 * 60_000))).toEqual({ costUsd: 0.5, activeMs: 5 * 60_000 });
		supervisor.gate(usage(0, 7 * 60_000, 1));
		expect(supervisor.researchRemaining(usage(0.8, 7 * 60_000))).toEqual({ costUsd: 0, activeMs: 0 });
		expect(createSupervisor({ profile: "chat", budget }).researchRemaining(usage(0.25)).costUsd).toBe(0.75);
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

describe("fases da pesquisa (as tools mudam de verdade)", () => {
	it("pesquisa -> lacunas -> escrita: a lista de tools liberadas encolhe e delegate/pesquisa saem", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		expect(supervisor.allowedTools()).toBeUndefined();
		expect(supervisor.phaseBlocked("web_search")).toBeUndefined();
		supervisor.gate(usage(0, 7 * 60_000, 1), { gaps: 2 });
		expect(supervisor.phase()).toBe("gaps");
		expect(supervisor.allowedTools()?.has("web_extract")).toBe(true);
		expect(supervisor.allowedTools()?.has("delegate")).toBe(false);
		expect(supervisor.phaseBlocked("delegate")).toMatch(/not available now/);
		supervisor.gate(usage(0, 9 * 60_000, 9), { gaps: 2 });
		expect(supervisor.phase()).toBe("write");
		expect(supervisor.phaseBlocked("web_search")).toMatch(/only the delivery is left/);
		expect(supervisor.phaseBlocked("create_file")).toBeUndefined();
		expect(supervisor.phaseBlocked("notebook_write")).toBeUndefined();
	});

	it("o chat curto nunca muda de fase", () => {
		const chat = createSupervisor({ profile: "chat", budget });
		chat.gate(usage(0.9, 0, 0), { listDone: true });
		expect(chat.phase()).toBe("research");
		expect(chat.allowedTools()).toBeUndefined();
	});

	it("insistir em tool barrada por 2 passos seguidos leva à entrega; um passo válido zera a contagem", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		supervisor.gate(usage(0, 8 * 60_000, 1));
		supervisor.recordBatchPhase(true);
		expect(supervisor.gate(usage(0, 8 * 60_000, 2)).action).toBe("call");
		supervisor.recordBatchPhase(false);
		supervisor.recordBatchPhase(true);
		expect(supervisor.gate(usage(0, 8 * 60_000, 3)).action).toBe("call");
		supervisor.recordBatchPhase(true);
		const gate = supervisor.gate(usage(0, 8 * 60_000, 4));
		expect(gate.action).toBe("deliver");
		if (gate.action === "deliver") expect(gate.stop).toEqual({ reason: "loop_repeat", detail: "phase_ignored" });
	});
});
