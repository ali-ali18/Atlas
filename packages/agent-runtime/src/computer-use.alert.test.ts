import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { createRoutine, deleteRoutine, listRoutines, updateRoutine } from "@workspace/db";
import { runComputerUse, COMPUTER_USE_TOOLS } from "./computer-use.js";
import { groupProcedureText } from "./context/prompt-blocks.js";
import type { AlertRunState } from "./tools/report-alert.js";

/** Alerta por condição: o bot propõe (propose_routine + alert) e, na rotina, fecha a verificação com report_alert. */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		listRoutines: vi.fn(async () => []),
		createRoutine: vi.fn(),
		updateRoutine: vi.fn(),
		deleteRoutine: vi.fn(async () => true),
	};
});

const toolCall = (id: string, name: string, args: Record<string, unknown>): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
});
const closing: CompleteChatWithToolsResult = { model: "test-model", message: { role: "assistant", content: "Pronto." } };

function routineRow(extra: Record<string, unknown> = {}) {
	return {
		id: "routine-1", userId: "user-1", botId: "bot-1", conversationId: null, name: "Estoque da canela", prompt: "Check the stock.", model: "", enabled: true,
		triggerType: "interval" as const, schedule: null, interval: { everyMinutes: 120 }, timezone: "America/Sao_Paulo", lastRunAt: null,
		createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
		alert: { condition: "o estoque de canela cair abaixo de 10", active: false },
		...extra,
	};
}

async function run(input: { message: string; calls: CompleteChatWithToolsResult[]; origin?: "chat" | "routine"; alertRun?: AlertRunState }) {
	const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
	const routines: Array<{ action: string; triggerType?: string; detail?: string }> = [];
	const seenTools: string[][] = [];
	const systems: string[] = [];
	const queue = [...input.calls];
	await runComputerUse({
		manager: {} as unknown as SandboxManager,
		getSessionId: async () => "s",
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: input.message }],
		runId: "run-alert", conversationId: "conv-alert", botId: "bot-1", userId: "user-1", maxSteps: 6,
		origin: input.origin ?? "chat",
		...(input.alertRun ? { alertRun: input.alertRun } : {}),
		onEvent: (event) => {
			if (event.type === "tool_result") toolResults.push(event);
			if (event.type === "routine") routines.push(event);
		},
		streamChat: async (params) => {
			seenTools.push(params.tools.map((tool) => tool.function.name));
			for (const message of params.messages) if (message.role === "system" && typeof message.content === "string") systems.push(message.content);
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { toolResults, routines, seenTools, systems };
}

/** Tool nativa adiada: a 1ª chamada só carrega o grupo; o modelo repete (comportamento real). */
const loaded = (call: CompleteChatWithToolsResult): CompleteChatWithToolsResult[] => {
	const first = call.message.tool_calls![0]!;
	return [call, { ...call, message: { ...call.message, tool_calls: [{ ...first, id: `${first.id}-retry` }] } }];
};

const STOCK_ALERT = {
	action: "create", title: "Estoque da canela", detail: "Read the current stock of canela from the ERP connector and compare with 10.",
	trigger_type: "interval", every_minutes: 120,
	alert: { condition: "o estoque de canela cair abaixo de 10", hint: "produto: canela; limite: 10" },
};

describe("propose_routine com alert (agent-first)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
	});

	it("a tool ensina quando usar o alerta e o prompt de rotinas tem a regra", () => {
		const tool = COMPUTER_USE_TOOLS.find((item) => item.function.name === "propose_routine")!;
		expect(tool.function.description).toMatch(/Alert by condition/);
		expect(tool.function.description).toMatch(/only when it newly becomes true/);
		expect(JSON.stringify(tool.function.parameters)).toContain("\"alert\"");
		const prompt = groupProcedureText(new Set(["routines"]));
		expect(prompt).toContain("Alerts by condition");
		expect(prompt).toContain("never build a \"notify every run\" routine");
		expect(prompt).toContain("A reminder at a date/time is `once`, not an alert");
	});

	it("replay: 'me avisa se o estoque de canela cair abaixo de 10' propõe uma rotina de alerta por intervalo", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: routineRow() } as never);
		const { toolResults, routines } = await run({
			message: "me avisa se o estoque de canela cair abaixo de 10",
			calls: [toolCall("c1", "propose_routine", STOCK_ALERT), closing],
		});
		expect(createRoutine).toHaveBeenCalledWith(
			"user-1",
			expect.objectContaining({
				triggerType: "interval",
				trigger: { kind: "interval", everyMinutes: 120 },
				alert: { condition: "o estoque de canela cair abaixo de 10", hint: "produto: canela; limite: 10" },
			}),
		);
		expect(toolResults[0]).toMatchObject({ ok: true });
		expect(toolResults[0]!.summary).toContain("Alerta · confere a cada 2 horas · avisa se o estoque de canela cair abaixo de 10");
		expect(routines[0]).toMatchObject({ action: "created", triggerType: "interval" });
		expect(routines[0]!.detail).toMatch(/^Alerta · confere a cada 2 horas/);
		expect(routines[0]!.detail).not.toMatch(/cron|\* \*/i);
	});

	it("alerta em horário fixo (cron) passa a condição ao db", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: routineRow({ triggerType: "cron", interval: undefined, schedule: "0 17 * * *", alert: { condition: "a venda do dia ficar abaixo da meta", active: false } }) } as never);
		await run({
			message: "se a venda do dia ficar abaixo da meta às 17h, me avisa",
			calls: [toolCall("c1", "propose_routine", { action: "create", title: "Meta do dia", detail: "Sum today's sales and compare with the target.", trigger_type: "cron", schedule: "0 17 * * *", alert: { condition: "a venda do dia ficar abaixo da meta" } }), closing],
		});
		expect(createRoutine).toHaveBeenCalledWith("user-1", expect.objectContaining({ triggerType: "cron", schedule: "0 17 * * *", alert: { condition: "a venda do dia ficar abaixo da meta" } }));
	});

	it("alerta com lembrete de uma vez (once) ou webhook é recusado com dica, sem criar nada", async () => {
		for (const [type, extra] of [["once", { run_at: "2099-01-01T10:00" }], ["event", {}], ["github", { github: { repo: "a/b", events: ["push"] } }]] as const) {
			vi.mocked(createRoutine).mockClear();
			const { toolResults } = await run({
				message: "me avisa",
				calls: [toolCall("c1", "propose_routine", { ...STOCK_ALERT, trigger_type: type, ...extra }), closing],
			});
			expect(toolResults[0]).toMatchObject({ ok: false });
			expect(toolResults[0]!.summary).toMatch(/alert only works with trigger_type cron or interval/);
			expect(createRoutine).not.toHaveBeenCalled();
		}
	});

	it("condição inválida volta como erro acionável", async () => {
		const { toolResults } = await run({
			message: "me avisa",
			calls: [toolCall("c1", "propose_routine", { ...STOCK_ALERT, alert: { hint: "sem condição" } }), closing],
		});
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(toolResults[0]!.summary).toMatch(/alert\.condition/);
		expect(createRoutine).not.toHaveBeenCalled();
	});

	it("edit troca a condição e, com condição vazia, remove o alerta", async () => {
		vi.mocked(listRoutines).mockResolvedValue([routineRow()] as never);
		vi.mocked(updateRoutine).mockResolvedValue(routineRow({ alert: { condition: "o estoque de canela cair abaixo de 5", active: false } }) as never);
		await run({
			message: "muda o alerta da rotina de estoque para 5",
			calls: [toolCall("c1", "propose_routine", { ...STOCK_ALERT, action: "edit", target: "Estoque da canela", alert: { condition: "o estoque de canela cair abaixo de 5" } }), closing],
		});
		expect(updateRoutine).toHaveBeenLastCalledWith("user-1", "bot-1", "routine-1", expect.objectContaining({ alert: { condition: "o estoque de canela cair abaixo de 5" }, intervalTrigger: { everyMinutes: 120 } }));
		await run({
			message: "tira o alerta da rotina de estoque, quero só a rotina",
			calls: [toolCall("c2", "propose_routine", { ...STOCK_ALERT, action: "edit", target: "Estoque da canela", alert: { condition: "" } }), closing],
		});
		expect(updateRoutine).toHaveBeenLastCalledWith("user-1", "bot-1", "routine-1", expect.objectContaining({ alert: null }));
	});

	it("edit sem o campo alert mantém o alerta (nada de alert no patch)", async () => {
		vi.mocked(listRoutines).mockResolvedValue([routineRow()] as never);
		vi.mocked(updateRoutine).mockResolvedValue(routineRow() as never);
		const { alert: _omit, ...withoutAlert } = STOCK_ALERT;
		await run({ message: "muda o intervalo da rotina de estoque", calls: [toolCall("c1", "propose_routine", { ...withoutAlert, action: "edit", target: "Estoque da canela", every_minutes: 240 }), closing] });
		expect(vi.mocked(updateRoutine).mock.calls.at(-1)![3]).not.toHaveProperty("alert");
	});
});

describe("horários inteligentes (nada de conferir a cada 30 min)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([]);
	});

	it("a tool e o prompt ensinam horários em dias úteis e o mínimo de 2 h", () => {
		const tool = COMPUTER_USE_TOOLS.find((item) => item.function.name === "propose_routine")!;
		expect(tool.function.description).toMatch(/Never pick every 30 minutes/);
		expect(tool.function.description).toContain("0 10,14,17 * * 1-5");
		expect(JSON.stringify(tool.function.parameters)).toContain("frequent");
		const prompt = groupProcedureText(new Set(["routines"]));
		expect(prompt).toContain("never default to every 30 minutes");
		expect(prompt).toContain("0 17 * * 1-5");
	});

	it("replay: 'me avisa se o estoque de canela cair abaixo de 10' vira conferência em horários úteis, não a cada 30 min", async () => {
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: routineRow({ triggerType: "cron", schedule: "0 10,14,17 * * 1-5", interval: undefined }) } as never);
		const { toolResults, routines } = await run({
			message: "me avisa se o estoque de canela cair abaixo de 10",
			calls: [toolCall("c1", "propose_routine", { ...STOCK_ALERT, trigger_type: "cron", every_minutes: undefined, schedule: "0 10,14,17 * * 1-5" }), closing],
		});
		expect(createRoutine).toHaveBeenCalledWith("user-1", expect.objectContaining({ triggerType: "cron", schedule: "0 10,14,17 * * 1-5" }));
		expect(toolResults[0]!.summary).toContain("Alerta · confere em dias úteis às 10h, 14h e 17h · avisa se o estoque de canela cair abaixo de 10");
		expect(routines[0]!.detail).toMatch(/^Alerta · confere em dias úteis às 10h, 14h e 17h/);
	});

	it("intervalo curto sem pedido explícito é recusado com a dica de horários; com pedido explícito passa", async () => {
		const refused = await run({ message: "me avisa se o estoque cair", calls: [toolCall("c1", "propose_routine", { ...STOCK_ALERT, every_minutes: 30 }), closing] });
		expect(refused.toolResults[0]).toMatchObject({ ok: false });
		expect(refused.toolResults[0]!.summary).toMatch(/at least 120|explicitly asked/);
		expect(createRoutine).not.toHaveBeenCalled();
		vi.mocked(createRoutine).mockResolvedValueOnce({ routine: routineRow({ interval: { everyMinutes: 10 } }) } as never);
		const allowed = await run({ message: "confere a cada 10 minutos o estoque de canela", calls: [toolCall("c2", "propose_routine", { ...STOCK_ALERT, every_minutes: 10, alert: { ...STOCK_ALERT.alert, frequent: true } }), closing] });
		expect(allowed.toolResults[0]).toMatchObject({ ok: true });
		expect(createRoutine).toHaveBeenCalledWith("user-1", expect.objectContaining({ trigger: { kind: "interval", everyMinutes: 10 } }));
	});

	it("editar o intervalo de um alerta existente também respeita o mínimo", async () => {
		vi.mocked(listRoutines).mockResolvedValue([routineRow()] as never);
		const { toolResults } = await run({ message: "confere mais vezes", calls: [toolCall("c1", "propose_routine", { ...STOCK_ALERT, action: "edit", target: "Estoque da canela", alert: undefined, every_minutes: 15 }), closing] });
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(updateRoutine).not.toHaveBeenCalled();
	});
});

describe("report_alert na execução da rotina", () => {
	const alertRun = (): AlertRunState => ({ condition: "o estoque de canela cair abaixo de 10", hint: "produto: canela", report: { verdict: null } });

	it("só aparece em rotina de alerta: nem no chat, nem em rotina comum", async () => {
		const state = alertRun();
		const alertRoutine = await run({ origin: "routine", message: "[EXECUÇÃO DE ROTINA]", alertRun: state, calls: [closing] });
		expect(alertRoutine.seenTools[0]).toContain("report_alert");
		const plain = await run({ origin: "routine", message: "[EXECUÇÃO DE ROTINA]", calls: [closing] });
		expect(plain.seenTools[0]).not.toContain("report_alert");
		const chat = await run({ origin: "chat", message: "oi", alertRun: alertRun(), calls: [closing] });
		expect(chat.seenTools[0]).not.toContain("report_alert");
	});

	it("o prompt da rotina de alerta traz a condição como dado e a instrução de usar report_alert", async () => {
		const { systems } = await run({ origin: "routine", message: "[EXECUÇÃO DE ROTINA]", alertRun: alertRun(), calls: [closing] });
		const note = systems.find((text) => text.includes("This run is an alert check"))!;
		expect(note).toContain("o estoque de canela cair abaixo de 10");
		expect(note).toContain("produto: canela");
		expect(note).toContain("call report_alert once");
		expect(note).toContain("do not message the user yourself");
	});

	it("registra o veredito e recusa o segundo", async () => {
		const state = alertRun();
		const { toolResults } = await run({
			origin: "routine", message: "[EXECUÇÃO DE ROTINA]", alertRun: state,
			calls: [
				toolCall("c1", "report_alert", { triggered: true, summary: "Estoque da canela: 7 un. (mínimo 10)" }),
				toolCall("c2", "report_alert", { triggered: false, summary: "mudei de ideia" }),
				closing,
			],
		});
		expect(state.report.verdict).toEqual({ triggered: true, summary: "Estoque da canela: 7 un. (mínimo 10)" });
		expect(JSON.parse(toolResults[0]!.summary)).toMatchObject({ recorded: true, triggered: true });
		expect(JSON.parse(toolResults[1]!.summary)).toMatchObject({ recorded: false, reason: "already_reported" });
	});

	it("args inválidos viram erro (ok:false) e não gravam veredito", async () => {
		const state = alertRun();
		const { toolResults } = await run({
			origin: "routine", message: "[EXECUÇÃO DE ROTINA]", alertRun: state,
			calls: [toolCall("c1", "report_alert", { triggered: "sim" }), toolCall("c2", "report_alert", { triggered: false, summary: " " }), closing],
		});
		expect(toolResults[0]).toMatchObject({ ok: false });
		expect(toolResults[0]!.summary).toMatch(/triggered must be a boolean/);
		expect(toolResults[1]).toMatchObject({ ok: false });
		expect(toolResults[1]!.summary).toMatch(/summary is required/);
		expect(state.report.verdict).toBeNull();
	});
});

describe("gerir alertas por conversa (tudo que o cartão da rotina faz)", () => {
	const plain = () => routineRow({ id: "routine-2", name: "Resumo da agenda", alert: undefined, triggerType: "cron", interval: undefined, schedule: "0 9 * * *" });
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValue([routineRow(), plain()] as never);
		vi.mocked(deleteRoutine).mockResolvedValue(true);
	});

	it("o prompt de rotinas ensina a listar e gerir sem mandar o usuário ao painel", () => {
		const prompt = groupProcedureText(new Set(["routines"]));
		expect(prompt).toContain("only_alerts");
		expect(prompt).toContain("routine_control");
		const tool = COMPUTER_USE_TOOLS.find((item) => item.function.name === "routine_control")!;
		expect(tool.function.description).toMatch(/alert already|only when its condition turns true/);
	});

	it("'quais alertas eu tenho?' lista só os alertas, com condição e frequência, escopado pelo dono", async () => {
		const { toolResults } = await run({ message: "quais alertas eu tenho?", calls: [...loaded(toolCall("c1", "list_routines", { only_alerts: true })), closing] });
		expect(listRoutines).toHaveBeenCalledWith("user-1", "bot-1");
		expect(toolResults.at(-1)!.summary).toContain("Alerta · confere a cada 2 horas · avisa se o estoque de canela cair abaixo de 10");
		expect(toolResults.at(-1)!.summary).not.toContain("Resumo da agenda");
	});

	it("sem alertas: diz que não há nenhum", async () => {
		vi.mocked(listRoutines).mockResolvedValue([plain()] as never);
		const { toolResults } = await run({ message: "quais alertas eu tenho?", calls: [...loaded(toolCall("c1", "list_routines", { only_alerts: true })), closing] });
		expect(toolResults.at(-1)!.summary).toBe("Nenhum alerta neste bot.");
	});

	it("pausa e retoma um alerta, com cartão visível", async () => {
		vi.mocked(updateRoutine).mockResolvedValueOnce(routineRow({ enabled: false }) as never);
		const paused = await run({ message: "pausa o alerta do estoque", calls: [...loaded(toolCall("c1", "routine_control", { action: "pause", target: "estoque" })), closing] });
		expect(updateRoutine).toHaveBeenLastCalledWith("user-1", "bot-1", "routine-1", { enabled: false });
		expect(paused.toolResults.at(-1)).toMatchObject({ ok: true });
		expect(paused.toolResults.at(-1)!.summary).toContain("pausado");
		expect(paused.routines[0]).toMatchObject({ action: "updated", title: "Estoque da canela" });
		expect(paused.routines[0]!.detail).toContain("Pausada");

		vi.mocked(listRoutines).mockResolvedValue([routineRow({ enabled: false })] as never);
		vi.mocked(updateRoutine).mockResolvedValueOnce(routineRow() as never);
		const resumed = await run({ message: "volta com o alerta do estoque", calls: [...loaded(toolCall("c2", "routine_control", { action: "resume", target: "Estoque da canela" })), closing] });
		expect(updateRoutine).toHaveBeenLastCalledWith("user-1", "bot-1", "routine-1", { enabled: true });
		expect(resumed.routines[0]!.detail).toContain("Retomada");
	});

	it("pausar o que já está pausado não grava nada", async () => {
		vi.mocked(listRoutines).mockResolvedValue([routineRow({ enabled: false })] as never);
		const { toolResults, routines } = await run({ message: "pausa o estoque", calls: [...loaded(toolCall("c1", "routine_control", { action: "pause", target: "estoque" })), closing] });
		expect(updateRoutine).not.toHaveBeenCalled();
		expect(toolResults.at(-1)!.summary).toContain("já está pausada");
		expect(routines).toHaveLength(0);
	});

	it("apaga um alerta (cartão sem link para a rotina apagada)", async () => {
		const { toolResults, routines } = await run({ message: "apaga o alerta do estoque", calls: [...loaded(toolCall("c1", "routine_control", { action: "delete", target: "estoque" })), closing] });
		expect(deleteRoutine).toHaveBeenCalledWith("user-1", "bot-1", "routine-1");
		expect(toolResults.at(-1)!.summary).toContain("apagado");
		expect(routines[0]).toMatchObject({ action: "updated", title: "Estoque da canela" });
		expect(routines[0]).not.toHaveProperty("routineId");
	});

	it("falha ao apagar vira erro de verdade (ok:false), sem sucesso falso", async () => {
		vi.mocked(deleteRoutine).mockResolvedValueOnce(false);
		const { toolResults } = await run({ message: "apaga", calls: [...loaded(toolCall("c1", "routine_control", { action: "delete", target: "estoque" })), closing] });
		expect(toolResults.at(-1)).toMatchObject({ ok: false });
	});

	it("rotina que não existe (ou é de outro dono: o db escopado não devolve) não altera nada", async () => {
		const { toolResults } = await run({ message: "apaga a rotina do vizinho", calls: [...loaded(toolCall("c1", "routine_control", { action: "delete", target: "rotina do vizinho" })), closing] });
		expect(toolResults.at(-1)!.summary).toMatch(/Não achei rotina/);
		expect(deleteRoutine).not.toHaveBeenCalled();
		expect(updateRoutine).not.toHaveBeenCalled();
	});

	it("liga/desliga o aviso (push) de uma rotina comum", async () => {
		vi.mocked(updateRoutine).mockResolvedValue(plain() as never);
		const off = await run({ message: "só me avisa do que for importante no resumo da agenda", calls: [...loaded(toolCall("c1", "routine_control", { action: "notify_important", target: "Resumo da agenda" })), closing] });
		expect(updateRoutine).toHaveBeenLastCalledWith("user-1", "bot-1", "routine-2", { notify: "important" });
		expect(off.routines[0]!.detail).toContain("importante");
		await run({ message: "volta a me avisar sempre", calls: [...loaded(toolCall("c2", "routine_control", { action: "notify_always", target: "Resumo da agenda" })), closing] });
		expect(updateRoutine).toHaveBeenLastCalledWith("user-1", "bot-1", "routine-2", { notify: "always" });
	});

	it("aviso de um alerta: explica que só avisa na virada e como silenciar, sem gravar", async () => {
		const { toolResults } = await run({ message: "para de me avisar do estoque", calls: [...loaded(toolCall("c1", "routine_control", { action: "notify_important", target: "estoque" })), closing] });
		expect(updateRoutine).not.toHaveBeenCalled();
		expect(toolResults.at(-1)!.summary).toMatch(/pause o alerta/);
	});

	it("muda a frequência de um alerta sem perder a condição", async () => {
		vi.mocked(updateRoutine).mockResolvedValue(routineRow({ interval: { everyMinutes: 180 } }) as never);
		await run({ message: "confere a cada 3 horas", calls: [toolCall("c1", "propose_routine", { ...STOCK_ALERT, action: "edit", target: "Estoque da canela", alert: undefined, every_minutes: 180 }), closing] });
		const patch = vi.mocked(updateRoutine).mock.calls.at(-1)![3];
		expect(patch).toMatchObject({ intervalTrigger: { everyMinutes: 180 } });
		expect(patch).not.toHaveProperty("alert");
	});

	it("dentro de uma execução de rotina a gestão é recusada", async () => {
		const { toolResults } = await run({ message: "run", origin: "routine", calls: [...loaded(toolCall("c1", "routine_control", { action: "delete", target: "estoque" })), closing] });
		expect(deleteRoutine).not.toHaveBeenCalled();
		expect(JSON.stringify(toolResults)).not.toContain("apagado");
	});
});
