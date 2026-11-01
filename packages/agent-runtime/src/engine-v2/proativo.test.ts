import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { DEFAULT_PROACTIVE_SETTINGS, type ProactiveSettings } from "@workspace/shared";
import {
	appendConversationMessage,
	appendRoutineProposalCard,
	cancelFollowup,
	createFollowup,
	createRoutineFromProposal,
	listFollowups,
	listRoutines,
	reserveProactiveMessage,
} from "@workspace/db";
import { BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION, runComputerUse, type ComputerUseParams } from "../computer-use.js";
import { buildMcpToolset } from "../mcp/registry.js";
import { briefToolFilter } from "../tools/daily-brief.js";
import type { AlertRunState } from "../tools/report-alert.js";
import { runEngineV2 } from "./run.js";

/**
 * Paridade v1 x v2 nas origens que antes ficavam só no v1: modo proativo do bot (chat, reflexão e lembrete),
 * push avulso (`notify_user`), alerta (`report_alert`), evento de configuração do bot e brief "Seu dia".
 * O MESMO roteiro e as MESMAS expectativas rodam nos dois motores (LLM mockado, db simulado).
 */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		createFollowup: vi.fn(async (input: { dueAt: Date; requestedFor: Date; note: string; kind: string }) => ({
			followup: { id: "f1", dueAt: input.dueAt, requestedFor: input.requestedFor, note: input.note, kind: input.kind },
			duplicate: false,
		})),
		getBotConversationId: vi.fn(async () => "conv-1"),
		listFollowups: vi.fn(async () => []),
		cancelFollowup: vi.fn(async () => true),
		listRoutines: vi.fn(async () => []),
		findRecentProposalByName: vi.fn(async () => null),
		appendRoutineProposalCard: vi.fn(async () => "msg-1"),
		recordProactiveEvent: vi.fn(async () => undefined),
		createRoutineFromProposal: vi.fn(async (_u: string, _b: string, spec: { name: string; schedule?: string; timezone: string }) => ({
			routine: { id: "r-new", name: spec.name, enabled: true, schedule: spec.schedule ?? null, timezone: spec.timezone, triggerType: "cron" },
		})),
		reserveProactiveMessage: vi.fn(async () => ({ allowed: true })),
		appendConversationMessage: vi.fn(async () => ({})),
		getBotProfile: vi.fn(async () => ({ description: "configurado" })),
		findExecutedConfirmCall: vi.fn(async () => null),
		persistJevStatusCard: vi.fn(async () => undefined),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		upsertTaskListCard: vi.fn(async () => undefined),
		getConversationUntrustedAt: vi.fn(async () => null),
		searchMemoryEntries: vi.fn(async () => []),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		saveSkillPendingIntent: vi.fn(async () => undefined),
		loadAutonomyContext: vi.fn(async () => ({ accountRaw: null, botRaw: null, botName: "Taldo" })),
	};
});

const toolCall = (name: string, args: Record<string, unknown>, id = "c1"): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
	finishReason: "tool_calls",
});
const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Agendei." }, finishReason: "stop" };
const settings: ProactiveSettings = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true };

type Engine = "v1" | "v2";
type RunInput = {
	origin?: string;
	conversationId?: string | null;
	message?: string;
	proactive?: boolean;
	routineMode?: "suggest" | "auto";
	userPush?: { mode: "routine" | "chat"; send: (text: string) => Promise<void> };
	alertRun?: AlertRunState;
	extra?: Partial<ComputerUseParams>;
	messages?: ComputerUseParams["messages"];
	calls: CompleteChatWithToolsResult[];
};

async function run(engine: Engine, input: RunInput) {
	const requests: Array<{ tools: string[]; systems: string[] }> = [];
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	const eventTypes: string[] = [];
	const queue = [...input.calls];
	const params: ComputerUseParams = {
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("nao deve criar sessao");
		},
		sandboxEnabled: false,
		model: "m",
		apiKey: "test",
		messages: input.messages ?? [{ role: "user", content: input.message ?? "semana que vem tenho prova de cálculo" }],
		botId: "bot-1",
		userId: "user-1",
		...(input.conversationId === null ? {} : { conversationId: input.conversationId ?? "conv-1" }),
		runId: "run-1",
		origin: (input.origin ?? "chat") as "chat",
		maxSteps: 6,
		...(input.userPush ? { userPush: input.userPush } : {}),
		...(input.alertRun ? { alertRun: input.alertRun } : {}),
		...(input.proactive === false ? {} : { proactive: { settings: { ...settings, routineMode: input.routineMode ?? "suggest" } } }),
		onEvent: (event) => {
			eventTypes.push(event.type);
			if (event.type === "tool_result") results.push(event as never);
		},
		streamChat: async (chat) => {
			requests.push({
				tools: chat.tools.map((tool) => tool.function.name),
				systems: chat.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
			});
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
		...input.extra,
	};
	const result = engine === "v1" ? await runComputerUse(params) : await runEngineV2(params, { profile: "chat" });
	return { requests, seenTools: requests.map((r) => r.tools), systems: requests[0]?.systems ?? [], results, eventTypes, result };
}

beforeEach(() => vi.clearAllMocks());

describe.each(["v1", "v2"] as const)("push avulso (notify_user) [%s]", (engine) => {
	it("rotina 'só importante': tool só-push, nota no prompt, uma vez por run", async () => {
		const send = vi.fn(async () => undefined);
		const { seenTools, systems, results } = await run(engine, {
			origin: "routine",
			proactive: false,
			userPush: { mode: "routine", send },
			calls: [toolCall("notify_user", { message: "Fatura vence hoje." }), toolCall("notify_user", { message: "De novo." }, "c2"), done],
		});
		expect(seenTools[0]).toContain("notify_user");
		expect(systems.some((text) => text.includes("notify only when something matters"))).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith("Fatura vence hoje.");
		expect(JSON.parse(results[1]!.summary)).toMatchObject({ sent: false, reason: "one_per_run" });
		expect(appendConversationMessage).not.toHaveBeenCalled();
	});

	it("rotina em modo 'sempre' (sem userPush): a tool não existe", async () => {
		const { seenTools } = await run(engine, { origin: "routine", proactive: false, calls: [done] });
		expect(seenTools[0]).not.toContain("notify_user");
	});

	it("chat com push liberado: tool presente, sem a nota de rotina", async () => {
		const send = vi.fn(async () => undefined);
		const { seenTools, systems } = await run(engine, {
			proactive: false,
			userPush: { mode: "chat", send },
			calls: [toolCall("notify_user", { message: "Preciso da sua aprovação para seguir." }), done],
		});
		expect(seenTools[0]).toContain("notify_user");
		expect(systems.some((text) => text.includes("notify only when something matters"))).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("o push respeita o silêncio do usuário e não envia", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T03:00:00Z") });
		try {
			const send = vi.fn(async () => undefined);
			const quiet = { ...settings, quietStart: "22:00", quietEnd: "08:00", timezone: "UTC" } as ProactiveSettings;
			const { results } = await run(engine, {
				origin: "routine",
				proactive: false,
				userPush: { mode: "routine", send, quiet } as never,
				calls: [toolCall("notify_user", { message: "Algo." }), done],
			});
			expect(send).not.toHaveBeenCalled();
			expect(JSON.parse(results[0]!.summary)).toMatchObject({ sent: false, reason: "quiet_hours" });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe.each(["v1", "v2"] as const)("modo proativo do bot [%s]", (engine) => {
	it("chat do bot principal com o modo ligado: tools e seção do prompt", async () => {
		const { seenTools, systems } = await run(engine, { calls: [done] });
		for (const name of ["schedule_followup", "list_followups", "cancel_followup", "reschedule_followup", "suggest_routine"]) expect(seenTools[0], name).toContain(name);
		expect(seenTools[0]).not.toContain("notify_user");
		const section = systems.find((text) => text.startsWith("Proactive mode (on):"));
		expect(section).toBeDefined();
		expect(section).toContain("schedule_followup");
		expect(section).toContain("Routine mode: suggest");
		expect(section).toContain("semana que vem tenho prova");
	});

	it("o prompt do chat reflete o modo Automático", async () => {
		const { systems } = await run(engine, { routineMode: "auto", message: "oi", calls: [done] });
		expect(systems.find((text) => text.startsWith("Proactive mode"))).toContain("Routine mode: automatic");
	});

	it("sem o modo ligado nenhuma tool nem seção proativa aparece", async () => {
		const { seenTools, systems } = await run(engine, { proactive: false, calls: [done] });
		for (const name of ["schedule_followup", "list_followups", "cancel_followup", "reschedule_followup", "suggest_routine", "notify_user", "report_alert"]) {
			expect(seenTools[0], name).not.toContain(name);
		}
		expect(systems.some((text) => text.startsWith("Proactive mode"))).toBe(false);
		expect(systems).toHaveLength(1);
	});

	it("rotina não recebe as tools proativas", async () => {
		const { seenTools } = await run(engine, { origin: "routine", proactive: true, calls: [done] });
		expect(seenTools[0]).not.toContain("schedule_followup");
	});

	it("reflexão (origin proativa, sem conversa) recebe notify_user e não recebe seção de chat", async () => {
		const { seenTools, systems } = await run(engine, { origin: "proactive", conversationId: null, calls: [done] });
		expect(seenTools[0]).toEqual(expect.arrayContaining(["schedule_followup", "list_followups", "suggest_routine", "notify_user"]));
		expect(seenTools[0]).not.toContain("cancel_followup");
		expect(systems.some((text) => text.startsWith("Proactive mode"))).toBe(false);
	});

	it("lembrete (origin proativa, com conversa) pode listar, remarcar e cancelar, mas não manda mensagem solta", async () => {
		const { seenTools } = await run(engine, { origin: "proactive", calls: [done] });
		expect(seenTools[0]).toEqual(expect.arrayContaining(["schedule_followup", "list_followups", "cancel_followup", "reschedule_followup"]));
		expect(seenTools[0]).not.toContain("notify_user");
		expect(seenTools[0]).not.toContain("suggest_routine");
	});

	it("reflexão: notify_user grava a mensagem na conversa do bot e respeita o teto no servidor", async () => {
		const { results } = await run(engine, {
			origin: "proactive",
			conversationId: null,
			calls: [toolCall("notify_user", { message: "A entrega vence amanhã." }), done],
		});
		expect(reserveProactiveMessage).toHaveBeenCalled();
		expect(appendConversationMessage).toHaveBeenCalledWith("conv-1", "assistant", "A entrega vence amanhã.");
		expect(JSON.parse(results[0]!.summary)).toMatchObject({ sent: true });
		vi.mocked(reserveProactiveMessage).mockResolvedValueOnce({ allowed: false, reason: "daily_cap" } as never);
		vi.mocked(appendConversationMessage).mockClear();
		const capped = await run(engine, { origin: "proactive", conversationId: null, calls: [toolCall("notify_user", { message: "Outra." }), done] });
		expect(appendConversationMessage).not.toHaveBeenCalled();
		expect(JSON.parse(capped.results[0]!.summary)).toMatchObject({ sent: false, reason: "daily_cap" });
	});

	it("schedule_followup roda de verdade e o resultado volta ao modelo", async () => {
		const { results } = await run(engine, { calls: [toolCall("schedule_followup", { when: "daqui a 3 dias", note: "Prova de cálculo" }), done] });
		expect(createFollowup).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1", botId: "bot-1", note: "Prova de cálculo", kind: "reminder", source: "chat", sourceRunId: "run-1" }),
		);
		expect(results[0]).toMatchObject({ name: "schedule_followup", ok: true });
		expect(JSON.parse(results[0]!.summary)).toMatchObject({ scheduled: true });
	});

	it("when inválido volta como erro da tool (ok:false), não como sucesso", async () => {
		const { results } = await run(engine, { calls: [toolCall("schedule_followup", { when: "quando der", note: "x" }), done] });
		expect(results[0]).toMatchObject({ name: "schedule_followup", ok: false });
		expect(results[0]!.summary).toMatch(/when inválido/);
	});

	it("follow-up autônomo (inferred): vira verificação silenciosa, sem card, sem mensagem e sem avisar", async () => {
		const note = "Check whether the NF (invoice) was issued; report only if it was issued or is still missing.";
		const { results, eventTypes, systems } = await run(engine, {
			message: "a NF deve sair amanhã",
			calls: [toolCall("schedule_followup", { when: "amanhã 16h", note, inferred: true }), done],
		});
		expect(systems.some((text) => text.includes("never ask permission and never announce it"))).toBe(true);
		expect(createFollowup).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", botId: "bot-1", kind: "check", source: "chat", note }));
		expect(JSON.parse(results[0]!.summary).note).toMatch(/Do NOT mention it to the user/);
		expect(eventTypes).not.toContain("routine");
		expect(appendConversationMessage).not.toHaveBeenCalled();
		expect(appendRoutineProposalCard).not.toHaveBeenCalled();
	});

	it("'o que você ficou de conferir?' lista e o usuário pode pedir para cancelar, pelo chat", async () => {
		const item = { id: "f9", kind: "check", source: "chat", note: "Ver se o pedido do cliente X chegou", dueAt: new Date(Date.now() + 86_400_000), stages: [] };
		vi.mocked(listFollowups).mockResolvedValue([item] as never);
		const listed = await run(engine, { message: "o que você ficou de conferir?", calls: [toolCall("list_followups", {}), done] });
		expect(listed.results[0]!.summary).toContain("f9");
		const cancelled = await run(engine, { message: "esquece o do cliente X", calls: [toolCall("cancel_followup", { id: "cliente X" }), done] });
		expect(cancelFollowup).toHaveBeenCalledWith("user-1", "f9", "bot-1");
		expect(cancelled.results[0]).toMatchObject({ ok: true });
		vi.mocked(listFollowups).mockResolvedValue([]);
	});

	describe("reflexão diária: propostas de rotina", () => {
		const reflection = { origin: "proactive", conversationId: null, message: "[PROACTIVE REFLECTION]" } as const;
		const routineCall = toolCall("suggest_routine", { name: "Resumo da semana", prompt: "Resuma a semana", cron: "0 8 * * 1" });

		it("nada a fazer: termina em silêncio", async () => {
			await run(engine, { ...reflection, calls: [{ model: "m", message: { role: "assistant", content: "DONE" }, finishReason: "stop" }] });
			expect(appendConversationMessage).not.toHaveBeenCalled();
			expect(appendRoutineProposalCard).not.toHaveBeenCalled();
			expect(createFollowup).not.toHaveBeenCalled();
			expect(reserveProactiveMessage).not.toHaveBeenCalled();
		});

		it("Sugerir: grava só o card pendente e a rotina não é criada", async () => {
			const { results } = await run(engine, { ...reflection, routineMode: "suggest", calls: [routineCall, done] });
			expect(createRoutineFromProposal).not.toHaveBeenCalled();
			expect(reserveProactiveMessage).toHaveBeenCalledTimes(1);
			expect(appendRoutineProposalCard).toHaveBeenCalledWith(
				"conv-1",
				expect.objectContaining({ kind: "routine-proposal", mode: "suggest", status: "pending", spec: expect.objectContaining({ name: "Resumo da semana", schedule: "0 8 * * 1" }) }),
			);
			expect(JSON.parse(results[0]!.summary)).toMatchObject({ proposed: true });
		});

		it("Automático: cria a rotina do bot, sincroniza o agendador e grava o card com Desfazer", async () => {
			const onRoutineMutated = vi.fn(async () => undefined);
			const { results } = await run(engine, { ...reflection, routineMode: "auto", extra: { onRoutineMutated: onRoutineMutated as never }, calls: [routineCall, done] });
			expect(createRoutineFromProposal).toHaveBeenCalledWith("user-1", "bot-1", expect.objectContaining({ name: "Resumo da semana" }));
			expect(onRoutineMutated).toHaveBeenCalledWith(expect.objectContaining({ id: "r-new" }));
			expect(appendRoutineProposalCard).toHaveBeenCalledWith("conv-1", expect.objectContaining({ mode: "auto", status: "pending", routineId: "r-new" }));
			expect(JSON.parse(results[0]!.summary)).toMatchObject({ created: true, mode: "auto" });
		});

		it("dedupe e silêncio/teto valem igual: sem card, sem criação", async () => {
			vi.mocked(listRoutines).mockResolvedValueOnce([{ name: "Resumo da semana", prompt: "x", schedule: "0 9 * * 1" }] as never);
			const dup = await run(engine, { ...reflection, routineMode: "auto", calls: [routineCall, done] });
			expect(createRoutineFromProposal).not.toHaveBeenCalled();
			expect(reserveProactiveMessage).not.toHaveBeenCalled();
			expect(JSON.parse(dup.results[0]!.summary)).toMatchObject({ created: false, reason: "similar_routine_exists" });
			vi.mocked(reserveProactiveMessage).mockResolvedValueOnce({ allowed: false, reason: "quiet_hours" } as never);
			const quiet = await run(engine, { ...reflection, routineMode: "auto", calls: [routineCall, done] });
			expect(createRoutineFromProposal).not.toHaveBeenCalled();
			expect(appendRoutineProposalCard).not.toHaveBeenCalled();
			expect(JSON.parse(quiet.results[0]!.summary)).toMatchObject({ sent: false, reason: "quiet_hours" });
		});

		it("o Jev bloqueia uma mensagem que não vale interromper (modo on, abaixo de 0,6)", async () => {
			const asked: string[] = [];
			await run(engine, {
				...reflection,
				calls: [toolCall("notify_user", { message: "Bom dia, tudo bem?" }), done],
				extra: {
					jev: {
						modes: { proactive: "on" },
						ask: async (request: { questions: unknown }) => {
							asked.push(JSON.stringify(request.questions));
							return { model: "jev", answers: { worth_interrupting: 0.2 }, durationMs: 1 };
						},
					} as never,
				},
			});
			expect(asked[0]).toContain("worth interrupting");
			expect(appendConversationMessage).not.toHaveBeenCalled();
			expect(reserveProactiveMessage).not.toHaveBeenCalled();
		});
	});
});

describe.each(["v1", "v2"] as const)("alerta por condição (report_alert) [%s]", (engine) => {
	const alert = (): AlertRunState => ({ condition: "o estoque de canela cair abaixo de 10", hint: "produto: canela", report: { verdict: null } });

	it("run de alerta: a tool e a nota da tarefa entram, e o veredito fica no estado que o worker lê", async () => {
		const state = alert();
		const { seenTools, systems, results } = await run(engine, {
			origin: "routine",
			proactive: false,
			alertRun: state,
			message: "[EXECUÇÃO DE ROTINA] verificar estoque",
			calls: [toolCall("report_alert", { triggered: true, summary: "Estoque da canela: 7 un. (mínimo 10)" }), toolCall("report_alert", { triggered: false, summary: "outra" }, "c2"), done],
		});
		expect(seenTools[0]).toContain("report_alert");
		expect(systems.some((text) => text.includes("This run is an alert check") && text.includes("o estoque de canela cair abaixo de 10"))).toBe(true);
		expect(state.report.verdict).toMatchObject({ triggered: true, summary: "Estoque da canela: 7 un. (mínimo 10)" });
		expect(results[0]).toMatchObject({ name: "report_alert", ok: true });
		expect(JSON.parse(results[1]!.summary)).toMatchObject({ recorded: false, reason: "already_reported" });
		expect(state.report.verdict?.triggered).toBe(true);
	});

	it("veredito inválido volta como erro da tool e não grava nada", async () => {
		const state = alert();
		const { results } = await run(engine, { origin: "routine", proactive: false, alertRun: state, calls: [toolCall("report_alert", { triggered: "talvez" }), done] });
		expect(results[0]).toMatchObject({ name: "report_alert", ok: false });
		expect(state.report.verdict).toBeNull();
	});

	it("o alerta não tem gestão de rotina nem web e não existe em chat nem sem alertRun", async () => {
		const withAlert = await run(engine, { origin: "routine", proactive: false, alertRun: alert(), calls: [done] });
		for (const gone of ["list_routines", "propose_routine", "routine_group", "web_search", "web_extract"]) expect(withAlert.seenTools[0], gone).not.toContain(gone);
		const chat = await run(engine, { proactive: false, alertRun: alert(), calls: [done] });
		expect(chat.seenTools[0]).not.toContain("report_alert");
		expect(chat.systems.some((text) => text.includes("This run is an alert check"))).toBe(false);
		const plain = await run(engine, { origin: "routine", proactive: false, calls: [done] });
		expect(plain.seenTools[0]).not.toContain("report_alert");
	});
});

describe.each(["v1", "v2"] as const)("evento de configuração do bot [%s]", (engine) => {
	const configMessages = [{ role: "user" as const, content: 'Bot "Taldo": [bot-created] faça o onboarding' }];

	it("sem a instrução nas mensagens, o runtime injeta a do evento e as tools do onboarding existem", async () => {
		const { systems, seenTools } = await run(engine, {
			proactive: false,
			messages: configMessages,
			extra: { objective: "[bot-created] faça o onboarding", humanTurn: false },
			calls: [done],
		});
		expect(systems.filter((text) => text === BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION)).toHaveLength(1);
		expect(seenTools[0]).toContain("propose_questionnaire");
		expect(seenTools[0]).toContain("propose_profile_update");
	});

	it("a instrução que o chamador já pôs em messages não é duplicada", async () => {
		const { systems } = await run(engine, {
			proactive: false,
			messages: [{ role: "system", content: BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION }, ...configMessages],
			extra: { objective: "[bot-created] faça o onboarding", humanTurn: false },
			calls: [done],
		});
		expect(systems.filter((text) => text === BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION)).toHaveLength(1);
	});

	it("conversa comum não recebe a instrução do evento", async () => {
		const { systems } = await run(engine, { proactive: false, message: "oi, tudo bem?", calls: [done] });
		expect(systems.some((text) => text.includes("BOT EVENT"))).toBe(false);
	});
});

describe.each(["v1", "v2"] as const)("brief 'Seu dia' [%s]", (engine) => {
	const autonomy = { level: "autonomous" as const, exceptions: [] };
	const connection = {
		id: "conn-mail", slug: "gmail", name: "Gmail", disabledTools: [],
		tools: [
			{ name: "search_messages", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
			{ name: "send_message", inputSchema: { type: "object", properties: { to: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: false } },
			{ name: "create_draft", inputSchema: { type: "object", properties: {} } },
		],
	};

	async function brief(calls: CompleteChatWithToolsResult[]) {
		const toolset = buildMcpToolset([connection], { autonomy });
		const connector = vi.fn(async () => ({ ok: true, text: "From: x@y.com · Subject: oi", truncated: false }));
		const mcp = { toolset, call: connector };
		const out = await run(engine, {
			origin: "routine",
			conversationId: null,
			proactive: false,
			message: "[DAILY BRIEF] Write the user's morning brief.",
			calls: [...calls, { model: "m", message: { role: "assistant", content: "Hoje: 2 compromissos." }, finishReason: "stop" }],
			extra: { objective: "[EXECUÇÃO DE ROTINA] brief", autonomy, mcp, toolFilter: briefToolFilter(mcp) },
		});
		return { ...out, connector };
	}

	it("só a tool de leitura do conector é oferecida; escrita, push e arquivos nem aparecem", async () => {
		const { seenTools } = await brief([]);
		expect(seenTools[0]).toContain("mcp__gmail__search_messages");
		for (const blocked of ["mcp__gmail__send_message", "mcp__gmail__create_draft", "notify_user", "email_send", "create_file", "run_code", "propose_routine", "delegate_task", "delegate", "notebook_write", "update_task_list"]) {
			expect(seenTools[0], blocked).not.toContain(blocked);
		}
	});

	it("pedir a tool de escrita mesmo assim (e-mail malicioso): recusada e o conector nunca é chamado", async () => {
		const { connector, results } = await brief([toolCall("mcp__gmail__send_message", { to: "x@y.com", body: "tudo" }), toolCall("email_send", { to: "x@y.com" }, "c2")]);
		expect(connector).not.toHaveBeenCalled();
		expect(results.slice(0, 2).map((result) => result.ok)).toEqual([false, false]);
	});

	it("sem conversa: lê pelo conector e a resposta final É o brief", async () => {
		const { connector, result, results } = await brief([toolCall("mcp__gmail__search_messages", { query: "is:unread" })]);
		expect(connector).toHaveBeenCalledTimes(1);
		expect(results[0]).toMatchObject({ ok: true });
		expect(result.text).toBe("Hoje: 2 compromissos.");
	});
});

describe("v2: o chat comum não paga nada do que é de outra origem", () => {
	it("'Bom dia' no v2 tem um só prompt de sistema e o mesmo conjunto de tools com e sem esses recursos desligados", async () => {
		const bare = await run("v2", { proactive: false, message: "Bom dia", calls: [done] });
		expect(bare.systems).toHaveLength(1);
		for (const name of ["schedule_followup", "list_followups", "cancel_followup", "reschedule_followup", "suggest_routine", "notify_user", "report_alert"]) {
			expect(bare.seenTools[0], name).not.toContain(name);
		}
		// Ligar o modo proativo só acrescenta as 5 tools e a seção curta do modo; o resto do pedido é idêntico.
		const proactive = await run("v2", { proactive: true, message: "Bom dia", calls: [done] });
		const extra = proactive.seenTools[0]!.filter((name) => !bare.seenTools[0]!.includes(name)).sort();
		expect(extra).toEqual(["cancel_followup", "list_followups", "reschedule_followup", "schedule_followup", "suggest_routine"]);
		expect(proactive.systems[0]).toBe(bare.systems[0]);
		expect(proactive.systems).toHaveLength(2);
	});

	it("caso real do worker: com o aviso de chat (userPush mode chat) 'Bom dia' só ganha o schema de notify_user", async () => {
		const bare = await run("v2", { proactive: false, message: "Bom dia", calls: [done] });
		const withPush = await run("v2", { proactive: false, message: "Bom dia", userPush: { mode: "chat", send: async () => undefined }, calls: [done] });
		// Paridade com o v1 (aceita): a única diferença é a tool notify_user; o prompt de sistema é byte a byte o mesmo.
		expect(withPush.seenTools[0]!.filter((name) => !bare.seenTools[0]!.includes(name))).toEqual(["notify_user"]);
		expect(bare.seenTools[0]!.filter((name) => !withPush.seenTools[0]!.includes(name))).toEqual([]);
		expect(withPush.systems).toEqual(bare.systems);
		const v1 = await run("v1", { proactive: false, message: "Bom dia", userPush: { mode: "chat", send: async () => undefined }, calls: [done] });
		expect(v1.seenTools[0]).toContain("notify_user");
	});
});
