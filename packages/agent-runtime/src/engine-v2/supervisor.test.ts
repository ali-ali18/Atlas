import { describe, expect, it } from "vitest";
import {
	CHAT_BUDGET,
	LONG_WORK_BUDGET,
	MAX_STEPS_SAFETY,
	STAGNATION_ACTION_NOTE,
	STAGNATION_STEPS,
	WAIT_REPEAT_LIMIT,
	GLOBAL_FAILURE_ABORT_AT,
	GLOBAL_FAILURE_NOTE_AT,
	deliveryInstruction,
	WRAP_UP_NOTE,
	stepsNoticeNote,
	PROMOTE_PLAN_STEPS,
	budgetForProfile,
	capSourcesFor,
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
		expect(ownerCapped().gate(usage(0, 4 * 60_000))).toEqual({ action: "call" });
		expect(ownerCapped().gate(usage(0, 6.4 * 60_000))).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(ownerCapped().gate(usage(0, 9 * 60_000))).toMatchObject({ action: "deliver", stop: { reason: "budget_wall" } });
		const unattended = createSupervisor({ profile: "chat", budget: OWNER_CHAT_8MIN });
		expect(unattended.gate(usage(0, 6.4 * 60_000))).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(unattended.gate(usage(0, 8 * 60_000))).toMatchObject({ action: "deliver", stop: { reason: "budget_wall" } });
		expect(unattended.promote(LONG)).toBe(false);
	});

	it("chat sem teto de tempo (o padrão): passar de 8 min, 1 h ou 10 h não dá WRAP_UP_NOTE, nem entrega, nem promove", () => {
		const supervisor = chat();
		for (const minutes of [7, 8, 9, 30, 60, 600]) {
			expect(supervisor.gate(usage(0, minutes * 60_000, 10)), `${minutes} min`).toEqual({ action: "call" });
		}
		expect(supervisor.fraction(usage(0, 600 * 60_000))).toBe(0);
		expect(supervisor.promoted).toBe(false);
	});

	it("dinheiro nunca promove nem para: US$ 50 gastos no chat sem teto seguem", () => {
		expect(chat().gate(usage(50, 60_000, 12))).toEqual({ action: "call" });
	});

	it("teto de conta explícito menor que o tempo já gasto entrega com honestidade em vez de promover para sempre", () => {
		const supervisor = chat();
		supervisor.promote({ maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: 5 * 60_000 });
		expect(supervisor.gate(usage(0, 9 * 60_000, 12))).toMatchObject({ action: "deliver", stop: { reason: "budget_wall" } });
	});

	it("teto de custo explícito no chat segue valendo: avisa a 80% e entrega no limite", () => {
		const capped = chat({ budget: { maxCostUsd: 1, maxActiveMs: 8 * 60_000 } });
		expect(capped.gate(usage(0.8, 60_000))).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(capped.gate(usage(1, 60_000))).toMatchObject({ action: "deliver", stop: { reason: "budget_cost" } });
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

	it("teto de passos do DONO: a instrução diz o valor e onde mudar; o de segurança mantém o texto de segurança", () => {
		const owner = createSupervisor({ profile: "long_work", budget, maxSteps: 40, stepsSource: "bot" }).gate(usage(0.01, 1000, 40));
		expect(owner.action === "deliver" && owner.instruction).toMatch(/step limit the owner configured for this run \(40 steps, set in this bot's settings/);
		const account = createSupervisor({ profile: "long_work", budget, maxSteps: 60, stepsSource: "account" }).gate(usage(0.01, 1000, 60));
		expect(account.action === "deliver" && account.instruction).toMatch(/the account settings/);
		const safety = createSupervisor({ profile: "long_work", budget }).gate(usage(0.01, 1000, MAX_STEPS_SAFETY));
		expect(safety.action === "deliver" && safety.instruction).toMatch(/safety step limit for a single run \(200 steps\)/);
		expect(safety.action === "deliver" && safety.instruction).not.toMatch(/owner configured/);
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
		// 1ª reincidência: 2ª nota, com alternativa, ainda sem abortar.
		const fourth = supervisor.recordTool(record({ step: 4 }));
		expect(fourth.abort).toBeUndefined();
		expect(fourth.notes[0]).toMatch(/last warning before the run stops/);
		const fifth = supervisor.recordTool(record({ step: 5 }));
		expect(fifth.abort).toEqual({ reason: "loop_repeat", detail: "after_note" });
	});

	it("6 esperas idênticas (sandbox_shell_wait, browser_wait) não viram laço; passando do limite elas contam como qualquer repetição", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		for (const name of ["sandbox_shell_wait", "browser_wait"]) {
			for (let step = 1; step <= 6; step++) expect(supervisor.recordTool(record({ step, name, argsKey: "job=1", resultKey: "still running" })), name).toEqual({ notes: [] });
		}
		let aborted = false;
		for (let step = 1; step <= WAIT_REPEAT_LIMIT + 6; step++) {
			if (supervisor.recordTool(record({ step, name: "sandbox_shell_wait", argsKey: "job=2", resultKey: "still running" })).abort) aborted = true;
		}
		expect(aborted).toBe(true);
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
		expect(supervisor.recordTool(record({ step: 4 })).notes).toHaveLength(1);
		expect(supervisor.recordTool(record({ step: 5 }))).toMatchObject({ abort: { reason: "loop_repeat" } });
	});

	it("a promoção pela lista de 3+ passos continua; ajudantes recebem tempo infinito para repartir (o plano dos ajudantes os limita)", () => {
		const supervisor = createSupervisor({ profile: "chat", budget: CHAT_BUDGET, promotable: true });
		expect(supervisor.gate(usage(0, 0, 1), { plannedSteps: PROMOTE_PLAN_STEPS })).toEqual({ action: "promote" });
		expect(supervisor.promote(LONG_WORK_BUDGET)).toBe(true);
		expect(supervisor.researchRemaining(usage(0, 5 * 60 * 60_000, 3)).activeMs).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("falhas da mesma tool: só nota, nunca bloqueio (trava removida em 03/11)", () => {
	it("3 falhas seguidas no mesmo alvo viram UMA nota; a tool segue disponível e o run não morre", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		const fail = (step: number) => supervisor.recordTool(record({ step, ok: false, argsKey: `a${step}`, resultKey: `e${step}`, message: "timeout" }));
		expect(fail(1).notes).toEqual([]);
		expect(fail(2).notes).toEqual([]);
		const third = fail(3);
		expect(third.abort).toBeUndefined();
		expect(third.notes).toHaveLength(1);
		expect(third.notes[0]).toMatch(/failed 3 times in a row/);
		expect(third.notes[0]).not.toMatch(/unavailable/);
		expect("toolBlocked" in supervisor).toBe(false);
		// A 4ª falha não repete a nota.
		expect(fail(4).notes).toEqual([]);
	});

	it("falhas em alvos diferentes não somam; um sucesso no meio zera", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		for (const [step, target] of ["a", "b", "c"].entries()) expect(supervisor.recordTool(record({ step, ok: false, argsKey: `${step}`, resultKey: `${step}`, target })).notes).toEqual([]);
		const other = createSupervisor({ profile: "long_work", budget });
		other.recordTool(record({ step: 1, ok: false, argsKey: "1", resultKey: "1" }));
		other.recordTool(record({ step: 2, ok: false, argsKey: "2", resultKey: "2" }));
		other.recordTool(record({ step: 3, ok: true, argsKey: "3", resultKey: "3" }));
		expect(other.recordTool(record({ step: 4, ok: false, argsKey: "4", resultKey: "4" })).notes).toEqual([]);
	});
});

describe("sem fases: o catálogo nunca é filtrado (trava removida em 03/11)", () => {
	it("o supervisor não expõe fase, tools liberadas nem bloqueio por fase", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget }) as unknown as Record<string, unknown>;
		for (const name of ["phase", "allowedTools", "phaseAllows", "phaseBlocked", "recordBatchPhase", "researchEnd", "toolBlocked", "setDocumentExpected"]) expect(name in supervisor, name).toBe(false);
	});

	it("lista concluída, 70% do tempo/passos/gasto e lacunas abertas não mudam nada: o gate só segue", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget, maxSteps: 100 });
		expect(supervisor.gate(usage(0.1, 1000, 4), { completedCount: 3, notebookCount: 2 })).toEqual({ action: "call" });
		// 70% do tempo (7 de 10 min), 70% dos passos e 75% do gasto: nenhum vira fase nem nota.
		expect(supervisor.gate(usage(0.75, 7 * 60_000, 70), { completedCount: 3, notebookCount: 2 })).toEqual({ action: "call" });
	});

	it("o aviso de 80% de um teto do dono vale também no trabalho longo, com texto honesto (cap), e a entrega vem a 100%", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		expect(supervisor.gate(usage(0.8, 1000, 3))).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(WRAP_UP_NOTE).not.toMatch(/budget/i);
		expect(supervisor.gate(usage(1, 1000, 4))).toMatchObject({ action: "deliver", stop: { reason: "budget_cost" } });
	});

	it("o limite de passos de segurança continua e a pesquisa não termina em 70% dele", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget: { maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: Number.POSITIVE_INFINITY }, maxSteps: 100 });
		expect(supervisor.gate(usage(0, 1000, 70))).toEqual({ action: "call" });
		expect(supervisor.gate(usage(0, 1000, 100))).toMatchObject({ action: "deliver", stop: { reason: "budget_steps" } });
	});
});

describe("estagnação: só uma nota, sem mudar fase nem tirar tool", () => {
	const noCap = { maxCostUsd: Number.POSITIVE_INFINITY, maxActiveMs: Number.POSITIVE_INFINITY };

	it("depois do primeiro progresso, STAGNATION_STEPS passos iguais viram a nota 'change the approach' e a contagem recomeça", () => {
		expect(STAGNATION_STEPS).toBe(8);
		const supervisor = createSupervisor({ profile: "long_work", budget: noCap });
		const at = (step: number, notebookCount: number) => supervisor.gate(usage(0, 1000, step), { notebookCount });
		expect(at(0, 1)).toEqual({ action: "call" });
		for (let step = 1; step < STAGNATION_STEPS; step += 1) expect(at(step, 1), `passo ${step}`).toEqual({ action: "call" });
		const gate = at(STAGNATION_STEPS, 1);
		expect(gate).toEqual({ action: "call", note: STAGNATION_ACTION_NOTE });
		expect(STAGNATION_ACTION_NOTE).not.toMatch(/budget|limit|time/i);
		// Depois da nota a contagem recomeça e o run segue.
		expect(at(STAGNATION_STEPS + 1, 1)).toEqual({ action: "call" });
	});

	it("resultado novo de tool é progresso: 20 ações com resultados distintos nunca estagnam", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget: noCap });
		supervisor.gate(usage(0, 0, 0), { notebookCount: 1 });
		for (let step = 1; step <= 20; step += 1) {
			supervisor.recordTool(record({ step, name: "browser_act", argsKey: `ref=${step}`, resultKey: `pagina-${step}` }));
			expect(supervisor.gate(usage(0, 0, step), { notebookCount: 1 }), `passo ${step}`).toEqual({ action: "call" });
		}
	});
});

describe("falhas consecutivas de qualquer tool: nota aos 8, entrega honesta aos 10 sem nenhum sucesso", () => {
	const fail = (supervisor: ReturnType<typeof createSupervisor>, step: number, name = `tool_${step % 5}`) =>
		supervisor.recordTool(record({ step, name, argsKey: `a${step}`, resultKey: `e${step}`, ok: false, target: `alvo-${step}`, message: `falhou ${step}` }));

	it("a nota vem aos 8 e o aborto (tool_failures) só aos 10 consecutivos", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		const notes: string[] = [];
		for (let step = 1; step < GLOBAL_FAILURE_ABORT_AT; step += 1) {
			const verdict = fail(supervisor, step);
			expect(verdict.abort, `passo ${step}`).toBeUndefined();
			notes.push(...verdict.notes);
		}
		expect(notes.filter((note) => note.includes(`last ${GLOBAL_FAILURE_NOTE_AT} tool calls`))).toHaveLength(1);
		expect(fail(supervisor, GLOBAL_FAILURE_ABORT_AT).abort).toEqual({ reason: "tool_failures", detail: "consecutive" });
	});

	it("um sucesso no meio zera a contagem; browser_wait não conta nem a favor nem contra", () => {
		const supervisor = createSupervisor({ profile: "long_work", budget });
		for (let step = 1; step <= 9; step += 1) fail(supervisor, step);
		supervisor.recordTool(record({ step: 10, name: "web_search", argsKey: "ok", resultKey: "ok", ok: true }));
		for (let step = 11; step <= 19; step += 1) expect(fail(supervisor, step).abort, `passo ${step}`).toBeUndefined();
		// Esperas bem-sucedidas no meio das falhas não zeram a sequência...
		const waiting = createSupervisor({ profile: "long_work", budget });
		for (let step = 1; step <= 9; step += 1) {
			fail(waiting, step);
			waiting.recordTool(record({ step: 100 + step, name: "browser_wait", argsKey: `w${step}`, resultKey: `w${step}`, ok: true }));
		}
		expect(fail(waiting, 10).abort).toMatchObject({ reason: "tool_failures" });
		// ...e esperas que falham não somam.
		const failingWaits = createSupervisor({ profile: "long_work", budget });
		for (let step = 1; step <= 30; step += 1) expect(failingWaits.recordTool(record({ step, name: "browser_wait", argsKey: `w${step}`, resultKey: `w${step}`, ok: false })).abort).toBeUndefined();
	});
});

describe("instruções de entrega honestas por motivo", () => {
	const BAD_WORDS = /\b(budget|limit|time)\b/i;

	it("loop_repeat e tool_failures dizem que a abordagem não funcionou, sem budget/limit/time", () => {
		for (const reason of ["loop_repeat", "tool_failures"] as const) {
			const text = deliveryInstruction(reason);
			expect(text, reason).toMatch(/did not work/);
			expect(text, reason).not.toMatch(BAD_WORDS);
		}
	});

	it("budget_steps cita só o limite de passos de segurança", () => {
		expect(deliveryInstruction("budget_steps")).toMatch(/safety step limit/);
		expect(deliveryInstruction("budget_steps")).not.toMatch(/spending|time cap/);
	});

	it("budget_cost cita o valor e a origem (conta, servidor ou bot) e manda contar ao usuário onde mudar", () => {
		const server = deliveryInstruction("budget_cost", { usd: 0.25, source: "server" });
		expect(server).toContain("US$ 0.25");
		expect(server).toMatch(/spending cap the owner configured/);
		expect(server).toMatch(/server configuration/);
		expect(server).toMatch(/where to change it/);
		expect(deliveryInstruction("budget_cost", { usd: 1, source: "account" })).toMatch(/account settings/);
		expect(deliveryInstruction("budget_cost", { usd: 2, source: "bot" })).toMatch(/this bot's settings/);
	});

	it("budget_wall cita o tempo configurado e a origem", () => {
		const text = deliveryInstruction("budget_wall", { ms: 20 * 60_000, source: "bot" });
		expect(text).toContain("20 min");
		expect(text).toMatch(/time cap the owner configured/);
		expect(text).toMatch(/this bot's settings/);
	});

	it("o supervisor entrega a origem do teto que disparou", () => {
		const cost = createSupervisor({ profile: "chat", budget: { maxCostUsd: 0.25, maxActiveMs: Number.POSITIVE_INFINITY }, capSources: { cost: "server" } }).gate(usage(0.25));
		expect(cost).toMatchObject({ action: "deliver", stop: { reason: "budget_cost" } });
		if (cost.action === "deliver") expect(cost.instruction).toMatch(/US\$ 0\.25.*server configuration/);
		const wall = createSupervisor({ profile: "chat", budget: CHAT_BUDGET, hardActiveMs: 30 * 60_000, capSources: { wall: "account" } }).gate(usage(0, 30 * 60_000));
		if (wall.action === "deliver") expect(wall.instruction).toMatch(/30 min.*account settings/);
	});

	it("capSourcesFor: o teto do worker vence; o gasto máximo do bot só é a origem quando está abaixo", () => {
		const base = { budget: { maxCostUsd: 0.25, maxActiveMs: Number.POSITIVE_INFINITY } };
		expect(capSourcesFor({ ...base, paramsCostCapUsd: 0.25, declared: { cost: "server" } }).cost).toBe("server");
		expect(capSourcesFor({ ...base, paramsCostCapUsd: 0.25 }).cost).toBe("account");
		expect(capSourcesFor({ ...base, paramsCostCapUsd: 1, longWorkBudgetUsd: 0.25, declared: { cost: "server" } }).cost).toBe("bot");
		expect(capSourcesFor({ budget: CHAT_BUDGET })).toEqual({});
	});
});

describe("aviso de passos (75% do teto efetivo)", () => {
	const make = (over: Partial<Parameters<typeof createSupervisor>[0]> = {}) => createSupervisor({ profile: "long_work", budget: LONG_WORK_BUDGET, ...over });
	const notesOver = (supervisor: ReturnType<typeof make>, total: number, from = 0) => {
		const at: number[] = [];
		for (let step = from; step < total; step += 1) {
			const gate = supervisor.gate(usage(0, 1000, step), { notebookCount: step });
			if (gate.action === "call" && gate.note?.startsWith("Step notice")) at.push(step);
		}
		return at;
	};

	it("run de 200 passos: o aviso aparece uma vez, no passo 150, com 50 restantes", () => {
		const supervisor = make();
		expect(notesOver(supervisor, 200)).toEqual([150]);
		expect(make().gate(usage(0, 1000, 150), { notebookCount: 1 })).toEqual({ action: "call", note: stepsNoticeNote(50) });
		expect(stepsNoticeNote(50)).toBe("Step notice: about 50 steps left in this run. Prioritize finishing the task and delivering; save partial results to the notebook if the work is long.");
	});

	it("teto do dono de 40 passos: o aviso aparece no 30", () => {
		expect(notesOver(make({ maxSteps: 40, stepsSource: "account" }), 40)).toEqual([30]);
	});

	it("retomada a partir do checkpoint não repete o aviso", () => {
		const first = make();
		expect(notesOver(first, 160)).toEqual([150]);
		const saved = JSON.parse(JSON.stringify(first.state()));
		expect(saved.stepsNoticeSent).toBe(true);
		const resumed = make();
		resumed.restore(saved);
		expect(notesOver(resumed, 200, 160)).toEqual([]);
	});

	it("a mensagem nova do usuário não libera o aviso de passos (o teto é cumulativo)", () => {
		const supervisor = make();
		notesOver(supervisor, 160);
		supervisor.onUserInput(usage(0, 1000, 160));
		expect(notesOver(supervisor, 200, 160)).toEqual([]);
	});

	it("convive com o aviso de 80% de um teto do dono sem se contradizer: cada um sai uma vez, no seu passo", () => {
		const supervisor = make({ budget: { maxCostUsd: 1, maxActiveMs: Number.POSITIVE_INFINITY }, maxSteps: 40 });
		const first = supervisor.gate(usage(0.85, 1000, 10));
		expect(first).toEqual({ action: "call", note: WRAP_UP_NOTE });
		expect(supervisor.gate(usage(0.85, 1000, 30))).toEqual({ action: "call", note: stepsNoticeNote(10) });
		expect(supervisor.gate(usage(0.85, 1000, 31))).toEqual({ action: "call" });
	});

	it("o aviso de passos não fala de tempo nem de custo, e a última chamada (budget_steps) também não", () => {
		expect(stepsNoticeNote(10)).not.toMatch(/\b(time|cost|spend)/i);
		expect(deliveryInstruction("budget_steps", { steps: 200 })).not.toMatch(/\btime\b/i);
	});
});
