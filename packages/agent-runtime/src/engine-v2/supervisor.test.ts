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
	PROMOTE_PLAN_STEPS,
	budgetForProfile,
	createSupervisor,
} from "./supervisor.js";

const budget = { maxCostUsd: 1, maxActiveMs: 10 * 60_000 };
/** Chat com teto de tempo que o DONO configurou (conta/bot): o padrão não tem mais tempo (decisão do dono, 02/11). */
const OWNER_CHAT_8MIN = { maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: 8 * 60_000 };
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
	it("nenhum perfil tem teto de US$ nem de tempo por padrão (decisão do dono, 02/11)", () => {
		expect(budgetForProfile("long_work")).toEqual(LONG_WORK_BUDGET);
		expect(LONG_WORK_BUDGET).toEqual({ maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: Number.POSITIVE_INFINITY });
		expect(budgetForProfile("chat")).toEqual(CHAT_BUDGET);
		expect(CHAT_BUDGET).toEqual({ maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: Number.POSITIVE_INFINITY });
	});

	it("o bot ajusta o trabalho longo, mas o teto de custo da conta vence", () => {
		expect(budgetForProfile("long_work", { longWorkBudgetUsd: 2, longWorkMinutes: 45 })).toEqual({ maxCostUsd: 2, maxActiveMs: 45 * 60_000 });
		expect(budgetForProfile("long_work", { longWorkBudgetUsd: 2, accountCapUsd: 0.8 }).maxCostUsd).toBe(0.8);
		// O ajuste de trabalho longo não mexe no chat.
		expect(budgetForProfile("chat", { longWorkBudgetUsd: 5, longWorkMinutes: 90 })).toEqual(CHAT_BUDGET);
	});
});

describe("piso de tempo (brief e lembrete check)", () => {
	it("o piso nunca baixa o trabalho longo maior, não cria teto onde não há, e os tetos do dono vencem; sem piso em US$", () => {
		// Sem teto de tempo no perfil, o piso não inventa um (só os tetos do dono limitam).
		expect(budgetForProfile("chat", { floor: { minutes: 30 } })).toEqual(CHAT_BUDGET);
		expect(budgetForProfile("long_work", { longWorkBudgetUsd: 2, longWorkMinutes: 45, floor: { minutes: 30 } })).toEqual({ maxCostUsd: 2, maxActiveMs: 45 * 60_000 });
		expect(budgetForProfile("chat", { floor: { minutes: 30 }, accountCapUsd: 0.1, accountCapMs: 5 * 60_000 })).toEqual({ maxCostUsd: 0.1, maxActiveMs: 5 * 60_000 });
		expect(budgetForProfile("chat")).toEqual(CHAT_BUDGET);
	});

	it("teto de conta explícito vale também no trabalho longo (sem gasto máximo do bot)", () => {
		expect(budgetForProfile("long_work", { accountCapUsd: 0.4 }).maxCostUsd).toBe(0.4);
	});
});

describe("promoção chat -> trabalho longo", () => {
	const LONG = { maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: 60 * 60_000 };
	const chat = (over: Partial<Parameters<typeof createSupervisor>[0]> = {}) => createSupervisor({ profile: "chat", budget: CHAT_BUDGET, promotable: true, ...over });

	it("tempo não promove mais: 80% de um teto de tempo do dono, com tool no último passo, só avisa (e entrega no limite)", () => {
		const ownerCapped = (over: Partial<Parameters<typeof createSupervisor>[0]> = {}) => chat({ budget: OWNER_CHAT_8MIN, ...over });
		expect(ownerCapped().gate(usage(0, 4 * 60_000), { lastStepHadTools: true })).toEqual({ action: "call" });
		expect(ownerCapped().gate(usage(0, 6.4 * 60_000), { lastStepHadTools: true })).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(ownerCapped().gate(usage(0, 9 * 60_000), { lastStepHadTools: true })).toMatchObject({ action: "deliver", stop: { reason: "budget_wall" } });
		const unattended = createSupervisor({ profile: "chat", budget: OWNER_CHAT_8MIN });
		expect(unattended.gate(usage(0, 6.4 * 60_000), { lastStepHadTools: true })).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(unattended.gate(usage(0, 8 * 60_000), { lastStepHadTools: true })).toMatchObject({ action: "deliver", stop: { reason: "budget_wall" } });
		expect(unattended.promote(LONG)).toBe(false);
	});

	it("chat sem teto de tempo (o padrão): passar de 8 min, 1 h ou 10 h não dá WRAP_UP_NOTE, nem entrega, nem promove", () => {
		const supervisor = chat();
		for (const minutes of [7, 8, 9, 30, 60, 600]) {
			expect(supervisor.gate(usage(0, minutes * 60_000, 10), { lastStepHadTools: true }), `${minutes} min`).toEqual({ action: "call" });
		}
		expect(supervisor.fraction(usage(0, 600 * 60_000))).toBe(0);
		expect(supervisor.promoted).toBe(false);
	});

	it("dinheiro nunca promove nem para: US$ 50 gastos no chat sem teto seguem", () => {
		expect(chat().gate(usage(50, 60_000, 12), { lastStepHadTools: true })).toEqual({ action: "call" });
	});

	it("promove no máximo uma vez e passa a valer o orçamento e as fases do trabalho longo", () => {
		const supervisor = chat();
		expect(supervisor.promote(LONG)).toBe(true);
		expect(supervisor.promote(LONG)).toBe(false);
		expect(supervisor.profile).toBe("long_work");
		expect(supervisor.budget).toEqual(LONG);
		expect(supervisor.promoted).toBe(true);
		// 9 min gastos não entregam; o trabalho longo (LONG, 60 min do dono neste teste) segue.
		expect(supervisor.gate(usage(3, 9 * 60_000, 20), { lastStepHadTools: true })).toEqual({ action: "call" });
		// Na reserva (70% do tempo do dono) a pesquisa fecha como no trabalho longo.
		expect(supervisor.gate(usage(3, 43 * 60_000, 25), { lastStepHadTools: true })).toMatchObject({ action: "call", note: expect.stringContaining("Research is over") });
		expect(supervisor.phase()).toBe("write");
	});

	it("teto de conta explícito menor que o tempo já gasto entrega com honestidade em vez de promover para sempre", () => {
		const supervisor = chat();
		supervisor.promote({ maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: 5 * 60_000 });
		expect(supervisor.gate(usage(0, 9 * 60_000, 12), { lastStepHadTools: true })).toMatchObject({ action: "deliver", stop: { reason: "budget_wall" } });
	});

	it("teto de custo explícito no chat segue valendo: avisa a 80% e entrega no limite", () => {
		const capped = chat({ budget: { maxCostUsd: 1, maxActiveMs: 8 * 60_000 } });
		expect(capped.gate(usage(0.8, 60_000), { lastStepHadTools: true })).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(capped.gate(usage(1, 60_000), { lastStepHadTools: true })).toMatchObject({ action: "deliver", stop: { reason: "budget_cost" } });
	});
});

describe("gate: aviso e entrega", () => {
	it("abaixo de 80% segue sem nota", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		expect(supervisor.gate(usage(0.5, 60_000))).toEqual({ action: "call" });
	});

	it("chat com teto de custo explícito: avisa UMA vez a 80% (por custo ou por tempo) e depois só segue", () => {
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

describe("mensagem nova do usuário renova o tempo (onUserInput)", () => {
	const chat = (over: Partial<Parameters<typeof createSupervisor>[0]> = {}) => createSupervisor({ profile: "chat", budget: OWNER_CHAT_8MIN, promotable: true, ...over });

	it("a fração de tempo recomeça em 0 a partir da mensagem; o aviso de fechamento pode vir de novo", () => {
		const supervisor = chat({ promotable: false });
		expect(supervisor.gate(usage(0, 6.8 * 60_000), { lastStepHadTools: false })).toEqual({ action: "call", note: WRAP_UP_NOTE });
		supervisor.onUserInput(usage(0, 6.8 * 60_000));
		expect(supervisor.fraction(usage(0, 6.8 * 60_000))).toBe(0);
		// Logo depois da mensagem: sem nota e sem entrega, mesmo com o passo anterior sem tool.
		expect(supervisor.gate(usage(0, 7 * 60_000), { lastStepHadTools: false })).toEqual({ action: "call" });
		// 80% do tempo NOVO (6,4 min depois da base) volta a avisar, uma vez.
		expect(supervisor.gate(usage(0, (6.8 + 6.4) * 60_000), { lastStepHadTools: false })).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(supervisor.gate(usage(0, (6.8 + 6.5) * 60_000), { lastStepHadTools: false })).toEqual({ action: "call" });
		expect(supervisor.gate(usage(0, (6.8 + 8) * 60_000), { lastStepHadTools: false })).toMatchObject({ action: "deliver", stop: { reason: "budget_wall" } });
	});

	it("mesmo com o chat já estourado (passou de 100%), a mensagem nova devolve o tempo cheio (sem promover por regex)", () => {
		const supervisor = chat();
		supervisor.onUserInput(usage(0, 9 * 60_000));
		expect(supervisor.gate(usage(0, 9 * 60_000), { lastStepHadTools: false })).toEqual({ action: "call" });
		expect(supervisor.promoted).toBe(false);
	});

	it("o gasto em US$ segue cumulativo: o teto de custo continua cortando depois da mensagem", () => {
		const supervisor = chat({ budget: { maxCostUsd: 1, maxActiveMs: 8 * 60_000 } });
		expect(supervisor.gate(usage(0.8, 60_000))).toEqual({ action: "call", note: WRAP_UP_NOTE });
		supervisor.onUserInput(usage(0.8, 60_000));
		// Custo 80% de novo: o aviso volta (a nota foi liberada), e 100% entrega.
		expect(supervisor.gate(usage(0.85, 120_000))).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(supervisor.gate(usage(1, 130_000))).toMatchObject({ action: "deliver", stop: { reason: "budget_cost" } });
	});

	it("teto absoluto de tempo (conta/bot) não é esticado pela renovação", () => {
		const supervisor = chat({ hardActiveMs: 10 * 60_000 });
		supervisor.onUserInput(usage(0, 6.8 * 60_000));
		expect(supervisor.gate(usage(0, 9 * 60_000))).toEqual({ action: "call" });
		expect(supervisor.gate(usage(0, 10 * 60_000))).toMatchObject({ action: "deliver", stop: { reason: "budget_wall" } });
	});

	it("estado de retomada: a nota não é reenviada e a base de tempo sobrevive", () => {
		const first = chat({ promotable: false });
		first.gate(usage(0, 6.8 * 60_000));
		first.onUserInput(usage(0, 7 * 60_000));
		first.gate(usage(0, (7 + 6.4) * 60_000));
		const saved = first.state();
		expect(saved).toEqual({ wrapUpSent: true, timeBaseMs: 7 * 60_000 });
		const resumed = chat({ promotable: false });
		resumed.restore(JSON.parse(JSON.stringify(saved)));
		expect(resumed.gate(usage(0, (7 + 6.6) * 60_000))).toEqual({ action: "call" });
		expect(resumed.fraction(usage(0, 8 * 60_000))).toBeCloseTo(1 / 8, 5);
		// Estado vazio ou de checkpoint antigo não muda nada.
		const old = chat({ promotable: false });
		old.restore(undefined);
		old.restore({});
		expect(old.state()).toEqual({});
	});

	it("depois da promoção a base também vale (fração do tempo do trabalho longo)", () => {
		const supervisor = chat();
		supervisor.promote({ maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: 60 * 60_000 });
		supervisor.onUserInput(usage(0, 30 * 60_000));
		expect(supervisor.fraction(usage(0, 36 * 60_000))).toBeCloseTo(0.1, 5);
	});
});

describe("promoção pela lista de tarefas do modelo", () => {
	const LONG = { maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: 60 * 60_000 };
	const chat = (over: Partial<Parameters<typeof createSupervisor>[0]> = {}) => createSupervisor({ profile: "chat", budget: CHAT_BUDGET, promotable: true, ...over });

	it("lista com 3+ passos promove o chat já no começo do tempo, mesmo sem tool no último passo", () => {
		expect(PROMOTE_PLAN_STEPS).toBe(3);
		expect(chat().gate(usage(0, 10_000), { plannedSteps: 3, lastStepHadTools: false })).toEqual({ action: "promote" });
		expect(chat().gate(usage(0, 10_000), { plannedSteps: 8 })).toEqual({ action: "promote" });
	});

	it("com 2 passos (ou nenhum) não promove", () => {
		expect(chat().gate(usage(0, 10_000), { plannedSteps: 2, lastStepHadTools: true })).toEqual({ action: "call" });
		expect(chat().gate(usage(0, 10_000), { plannedSteps: 0 })).toEqual({ action: "call" });
		expect(chat().gate(usage(0, 10_000))).toEqual({ action: "call" });
	});

	it("só uma vez: depois de promovido a lista não promove de novo", () => {
		const supervisor = chat();
		expect(supervisor.gate(usage(0, 10_000), { plannedSteps: 4 })).toEqual({ action: "promote" });
		expect(supervisor.promote(LONG)).toBe(true);
		expect(supervisor.gate(usage(0, 20_000), { plannedSteps: 4 })).toEqual({ action: "call" });
		expect(supervisor.promote(LONG)).toBe(false);
	});

	it("sem permissão de promover (e-mail recebido, webhook, rotina) a lista nunca promove", () => {
		const outsider = createSupervisor({ profile: "chat", budget: CHAT_BUDGET });
		expect(outsider.gate(usage(0, 10_000), { plannedSteps: 5, lastStepHadTools: true })).toEqual({ action: "call" });
		expect(outsider.promote(LONG)).toBe(false);
		const explicit = chat({ promotable: false });
		expect(explicit.gate(usage(0, 10_000), { plannedSteps: 5 })).toEqual({ action: "call" });
	});

	it("o teto de custo continua valendo depois de promover pela lista", () => {
		const supervisor = chat();
		expect(supervisor.gate(usage(0.1, 10_000), { plannedSteps: 3 })).toEqual({ action: "promote" });
		supervisor.promote({ maxCostUsd: 1, maxActiveMs: 60 * 60_000 });
		expect(supervisor.gate(usage(1, 20_000), { plannedSteps: 3 })).toMatchObject({ action: "deliver", stop: { reason: "budget_cost" } });
	});
});

describe("sem orçamento de tempo (decisão do dono, 02/11)", () => {
	const noCap = { maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: Number.POSITIVE_INFINITY };

	it("chat de 9 min (now injetado pelo activeMs) não recebe WRAP_UP_NOTE nem deliver; nada vira NaN", () => {
		const supervisor = createSupervisor({ profile: "chat", budget: CHAT_BUDGET });
		const gate = supervisor.gate(usage(0, 9 * 60_000, 5));
		expect(gate).toEqual({ action: "call" });
		expect(Number.isNaN(supervisor.fraction(usage(0, 9 * 60_000)))).toBe(false);
		expect(supervisor.fraction(usage(5, 9 * 60_000))).toBe(0);
		expect(supervisor.researchRemaining(usage(0, 9 * 60_000))).toEqual({ costUsd: Number.POSITIVE_INFINITY, activeMs: Number.POSITIVE_INFINITY });
	});

	it("tetos do dono continuam iguais: custo, tempo e hardActiveMs avisam a 80% e entregam no limite", () => {
		const owner = createSupervisor({ profile: "chat", budget: { maxCostUsd: 1, maxActiveMs: 8 * 60_000 } });
		expect(owner.gate(usage(0, 6.4 * 60_000))).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(owner.gate(usage(0, 8 * 60_000))).toMatchObject({ action: "deliver", stop: { reason: "budget_wall" } });
		const hard = createSupervisor({ profile: "chat", budget: CHAT_BUDGET, hardActiveMs: 30 * 60_000 });
		expect(hard.gate(usage(0, 29 * 60_000))).toEqual({ action: "call" });
		expect(hard.gate(usage(0, 30 * 60_000))).toMatchObject({ action: "deliver", stop: { reason: "budget_wall" } });
		// longWorkMinutes / gasto do bot e teto da conta compõem com o perfil sem tempo.
		expect(budgetForProfile("long_work", { longWorkMinutes: 45, accountCapMs: 20 * 60_000 }).maxActiveMs).toBe(20 * 60_000);
		expect(budgetForProfile("long_work", { longWorkMinutes: 45 }).maxActiveMs).toBe(45 * 60_000);
		expect(budgetForProfile("chat", { accountCapMs: 0 })).toEqual(CHAT_BUDGET);
	});

	it("o laço sem tempo termina por MAX_STEPS_SAFETY (chat e trabalho longo)", () => {
		for (const profile of ["chat", "long_work"] as const) {
			const supervisor = createSupervisor({ profile, budget: noCap });
			expect(supervisor.gate(usage(0, 10 * 60 * 60_000, MAX_STEPS_SAFETY - 1)).action, profile).toBe("call");
			const gate = supervisor.gate(usage(0, 10 * 60 * 60_000, MAX_STEPS_SAFETY));
			expect(gate, profile).toMatchObject({ action: "deliver", stop: { reason: "budget_steps" } });
		}
	});

	it("o laço sem tempo termina por repetição: nota na 3ª igual, aborto na 4ª", () => {
		const supervisor = createSupervisor({ profile: "chat", budget: noCap });
		supervisor.recordTool(record({ step: 1 }));
		supervisor.recordTool(record({ step: 2 }));
		expect(supervisor.recordTool(record({ step: 3 })).notes).toHaveLength(1);
		expect(supervisor.recordTool(record({ step: 4 }))).toMatchObject({ abort: { reason: "loop_repeat" } });
	});

	it("falhas seguidas continuam bloqueando a tool sem tempo", () => {
		const supervisor = createSupervisor({ profile: "chat", budget: noCap });
		for (let step = 1; step <= 3; step++) supervisor.recordTool(record({ step, ok: false, argsKey: `q=${step}`, message: "boom" }));
		expect(supervisor.toolBlocked("web_search", 4)).toMatch(/temporarily unavailable/);
	});

	it("trabalho longo sem tempo vai da pesquisa para a escrita por PASSOS (70% do teto de segurança)", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget: noCap });
		const idleHours = 10 * 60 * 60_000;
		expect(supervisor.gate(usage(0, idleHours, Math.floor(MAX_STEPS_SAFETY * 0.7) - 1))).toEqual({ action: "call" });
		const gate = supervisor.gate(usage(0, idleHours, Math.ceil(MAX_STEPS_SAFETY * 0.7)));
		expect(gate).toMatchObject({ action: "call", note: expect.stringContaining("Research is over") });
		expect(supervisor.researchEnd()).toBe("steps");
		expect(supervisor.phase()).toBe("write");
		expect(supervisor.researchRemaining(usage(0, idleHours, 150))).toEqual({ costUsd: 0, activeMs: 0 });
	});

	it("trabalho longo sem tempo vai para a escrita por ESTAGNAÇÃO e por lista concluída", () => {
		const stalled = createSupervisor({ profile: "long_work", budget: noCap });
		stalled.gate(usage(0, 0, 1), { notebookCount: 1 });
		stalled.gate(usage(0, 0, 2), { notebookCount: 2 });
		let gate: ReturnType<typeof stalled.gate> = { action: "call" };
		for (let step = 3; step < 3 + STAGNATION_STEPS; step++) gate = stalled.gate(usage(0, 99 * 60 * 60_000, step), { notebookCount: 2 });
		expect(gate).toMatchObject({ action: "call", note: expect.stringContaining("Research is over") });
		expect(stalled.researchEnd()).toBe("stagnation");

		const done = createSupervisor({ profile: "long_work", budget: noCap });
		expect(done.gate(usage(0, 99 * 60 * 60_000, 5), { listDone: true })).toMatchObject({ action: "call", note: expect.stringContaining("Research is over") });
		expect(done.researchEnd()).toBe("list_done");
	});

	it("a promoção pela lista de 3+ passos continua; ajudantes recebem tempo infinito para repartir (o plano dos ajudantes os limita)", () => {
		const supervisor = createSupervisor({ profile: "chat", budget: CHAT_BUDGET, promotable: true });
		expect(supervisor.gate(usage(0, 0, 1), { plannedSteps: PROMOTE_PLAN_STEPS })).toEqual({ action: "promote" });
		expect(supervisor.promote(LONG_WORK_BUDGET)).toBe(true);
		expect(supervisor.researchRemaining(usage(0, 5 * 60 * 60_000, 3)).activeMs).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("estagnação: resultado novo é progresso; fase de escrita mantém as tools de ação", () => {
	const noCap = { maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: Number.POSITIVE_INFINITY };
	const action = (step: number, result: string, over: Partial<ReturnType<typeof record>> = {}) => record({ step, name: "browser_act", argsKey: `ref=${step}`, resultKey: result, ...over });

	it("STAGNATION_STEPS é 8 (ação de navegador legítima precisa de fôlego)", () => {
		expect(STAGNATION_STEPS).toBe(8);
	});

	it("passos de ação com resultados distintos nunca estagnam; resultados repetidos ou falhas estagnam", () => {
		const moving = createSupervisor({ profile: "long_work", budget: noCap });
		moving.gate(usage(0, 0, 1), { notebookCount: 1 });
		for (let step = 2; step < 40; step++) {
			moving.recordTool(action(step, `pagina-${step}`));
			expect(moving.gate(usage(0, 0, step), { notebookCount: 1 }).action).toBe("call");
			expect(moving.phase()).toBe("research");
		}
		const stuck = createSupervisor({ profile: "long_work", budget: noCap });
		stuck.gate(usage(0, 0, 1), { notebookCount: 1 });
		// O 1º resultado ainda é novo (progresso); os 8 passos seguintes repetem a mesma página.
		for (let step = 2; step < 3 + STAGNATION_STEPS; step++) {
			stuck.recordTool(action(step, "mesma-pagina"));
			stuck.gate(usage(0, 0, step), { notebookCount: 1 });
		}
		expect(stuck.researchEnd()).toBe("stagnation");
		// Falha nunca é progresso, mesmo com mensagem diferente a cada vez.
		const failing = createSupervisor({ profile: "long_work", budget: noCap });
		failing.gate(usage(0, 0, 1), { notebookCount: 1 });
		for (let step = 2; step < 2 + STAGNATION_STEPS; step++) {
			failing.recordTool(action(step, `erro-${step}`, { ok: false, message: `falha ${step}` }));
			failing.gate(usage(0, 0, step), { notebookCount: 1 });
		}
		expect(failing.researchEnd()).toBe("stagnation");
	});

	it("capturas de tela com bytes diferentes e sem texto novo NÃO são progresso: continuam estagnando", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget: noCap });
		supervisor.gate(usage(0, 0, 1), { notebookCount: 1 });
		for (let step = 2; step < 4 + STAGNATION_STEPS; step++) {
			supervisor.recordTool(record({ step, name: "screenshot", argsKey: `shot=${step}`, resultKey: `bytes-${step}-${"x".repeat(step)}` }));
			supervisor.gate(usage(0, 0, step), { notebookCount: 1 });
		}
		expect(supervisor.researchEnd()).toBe("stagnation");
		// Texto novo (browser_read) ou URL nova vale como progresso.
		const reading = createSupervisor({ profile: "long_work", budget: noCap });
		reading.gate(usage(0, 0, 1), { notebookCount: 1 });
		for (let step = 2; step < 4 + STAGNATION_STEPS; step++) {
			reading.recordTool(record({ step, name: "browser_read", argsKey: "same", resultKey: `texto novo ${step}` }));
			reading.gate(usage(0, 0, step), { notebookCount: 1 });
		}
		expect(reading.researchEnd()).toBeUndefined();
	});

	it("sem tempo, RESEARCH_TIME_RATIO não existe: a pesquisa nunca acaba por 'time'; com tempo do dono, acaba aos 70%", () => {
		const infinite = createSupervisor({ profile: "long_work", budget: noCap });
		for (let step = 1; step < 20; step++) infinite.gate(usage(0, step * 60 * 60_000, step), { notebookCount: step });
		expect(infinite.researchEnd()).toBeUndefined();
		const owner = createSupervisor({ profile: "long_work", budget: { maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: 10 * 60_000 } });
		owner.gate(usage(0, 7 * 60_000, 1));
		expect(owner.researchEnd()).toBe("time");
	});

	it("na escrita, pedido sem documento mantém browser e sandbox; com documento só escrita", () => {
		const make = (keepActionTools: boolean) => {
			const supervisor = createSupervisor({ profile: "long_work", budget: noCap, keepActionTools });
			supervisor.gate(usage(0, 0, 1), { listDone: true });
			expect(supervisor.phase()).toBe("write");
			return supervisor;
		};
		const keep = make(true);
		for (const name of ["browser_act", "browser_snapshot", "sandbox_shell", "create_file", "notebook_write"]) expect(keep.phaseBlocked(name), name).toBeUndefined();
		for (const name of ["web_search", "delegate", "memory_search"]) expect(keep.phaseBlocked(name), name).toMatch(/not available/);
		const document = make(false);
		expect(document.phaseBlocked("browser_act")).toMatch(/not available/);
		expect(document.phaseAllows("create_file")).toBe(true);
	});
});
