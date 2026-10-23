import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { DEFAULT_PROACTIVE_SETTINGS, type ProactiveSettings } from "@workspace/shared";
import {
	appendConversationMessage,
	appendRoutineProposalCard,
	cancelFollowup,
	createFollowup,
	listFollowups,
	createRoutineFromProposal,
	listRoutines,
	reserveProactiveMessage,
} from "@workspace/db";
import { runComputerUse } from "./computer-use.js";

/** Modo proativo no loop do agente (LLM mockado): quais tools aparecem, prompt do chat e execução real do schedule_followup. */

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
		getBotProfile: vi.fn(async () => null),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
	};
});

const toolCall = (name: string, args: Record<string, unknown>, id = "c1"): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
});
const done: CompleteChatWithToolsResult = { model: "test-model", message: { role: "assistant", content: "Agendei." } };
const settings: ProactiveSettings = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true };

async function run(input: {
	routineMode?: "suggest" | "auto";
	onRoutineMutated?: (routine: { id: string }) => Promise<void>;
	origin?: string;
	conversationId?: string | null;
	proactive?: boolean;
	userPush?: { mode: "routine" | "chat"; send: (text: string) => Promise<void> };
	calls: CompleteChatWithToolsResult[];
	message?: string;
}) {
	const seenTools: string[][] = [];
	const systems: string[] = [];
	const results: Array<{ name: string; ok: boolean; summary: string }> = [];
	const eventTypes: string[] = [];
	const queue = [...input.calls];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("nao deve criar sessao");
		},
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: input.message ?? "semana que vem tenho prova de cálculo" }],
		botId: "bot-1",
		userId: "user-1",
		...(input.conversationId === null ? {} : { conversationId: input.conversationId ?? "conv-1" }),
		runId: "run-1",
		origin: (input.origin ?? "chat") as "chat",
		maxSteps: 4,
		...(input.onRoutineMutated ? { onRoutineMutated: input.onRoutineMutated as never } : {}),
		...(input.userPush ? { userPush: input.userPush } : {}),
		...(input.proactive === false ? {} : { proactive: { settings: { ...settings, routineMode: input.routineMode ?? "suggest" } } }),
		onEvent: (event) => {
			eventTypes.push(event.type);
			if (event.type === "tool_result") results.push(event as never);
		},
		streamChat: async (params) => {
			seenTools.push(params.tools.map((tool) => tool.function.name));
			for (const message of params.messages) {
				if (message.role === "system" && typeof message.content === "string") systems.push(message.content);
			}
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { seenTools, systems, results, eventTypes };
}

describe("notify_user como push avulso no loop do agente", () => {
	it("rotina com push liberado: tool só-push, nota no prompt, uma vez por run", async () => {
		const send = vi.fn(async () => undefined);
		const { seenTools, systems, results } = await run({
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
		expect(vi.mocked(appendConversationMessage)).not.toHaveBeenCalled();
	});

	it("rotina em modo always (sem userPush): a tool não existe", async () => {
		const { seenTools } = await run({ origin: "routine", proactive: false, calls: [done] });
		expect(seenTools[0]).not.toContain("notify_user");
	});

	it("chat com push liberado: tool presente, sem nota de rotina e sem duplicar mensagem", async () => {
		const send = vi.fn(async () => undefined);
		const { seenTools, systems } = await run({
			proactive: false,
			userPush: { mode: "chat", send },
			calls: [toolCall("notify_user", { message: "Preciso da sua aprovação para seguir." }), done],
		});
		expect(seenTools[0]).toContain("notify_user");
		expect(systems.some((text) => text.includes("notify only when something matters"))).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe("modo proativo no loop do agente", () => {
	it("chat do bot principal com o modo ligado: tools e seção do prompt", async () => {
		const { seenTools, systems } = await run({ calls: [done] });
		for (const name of ["schedule_followup", "list_followups", "cancel_followup", "suggest_routine"]) expect(seenTools[0]).toContain(name);
		expect(seenTools[0]).not.toContain("notify_user");
		const section = systems.find((text) => text.startsWith("Proactive mode (on):"));
		expect(section).toBeDefined();
		expect(section).toContain("schedule_followup");
		expect(section).toContain("Routine mode: suggest");
		expect(section).toContain("semana que vem tenho prova");
	});

	it("o prompt do chat reflete o modo Automático", async () => {
		const seen: string[] = [];
		const queue = [done];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("x");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "oi" }],
			botId: "bot-1",
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
			origin: "chat",
			maxSteps: 2,
			proactive: { settings: { ...settings, routineMode: "auto" } },
			onEvent: () => undefined,
			streamChat: async (params) => {
				for (const m of params.messages) if (m.role === "system" && typeof m.content === "string") seen.push(m.content);
				return queue.shift()!;
			},
		});
		expect(seen.find((text) => text.startsWith("Proactive mode"))).toContain("Routine mode: automatic");
	});

	it("sem o modo ligado (ou em bot não principal) nenhuma tool proativa aparece", async () => {
		const { seenTools, systems } = await run({ proactive: false, calls: [done] });
		for (const name of ["schedule_followup", "list_followups", "cancel_followup", "suggest_routine", "notify_user"]) {
			expect(seenTools[0]).not.toContain(name);
		}
		expect(systems.some((text) => text.startsWith("Proactive mode"))).toBe(false);
	});

	it("rotina e webhook não recebem as tools", async () => {
		for (const origin of ["routine", "webhook"]) {
			const { seenTools } = await run({ origin, proactive: true, calls: [done] });
			expect(seenTools[0]).not.toContain("schedule_followup");
		}
	});

	it("reflexão (origin proativa, sem conversa) recebe notify_user e não recebe seção de chat", async () => {
		const { seenTools, systems } = await run({ origin: "proactive", conversationId: null, calls: [done] });
		expect(seenTools[0]).toEqual(expect.arrayContaining(["schedule_followup", "suggest_routine", "notify_user"]));
		expect(seenTools[0]).not.toContain("cancel_followup");
		expect(systems.some((text) => text.startsWith("Proactive mode"))).toBe(false);
	});

	it("reflexão: notify_user grava a mensagem na conversa do bot e respeita o teto no servidor", async () => {
		const { results } = await run({
			origin: "proactive",
			conversationId: null,
			calls: [toolCall("notify_user", { message: "A entrega vence amanhã." }), done],
		});
		expect(reserveProactiveMessage).toHaveBeenCalled();
		expect(appendConversationMessage).toHaveBeenCalledWith("conv-1", "assistant", "A entrega vence amanhã.");
		expect(JSON.parse(results[0]!.summary)).toMatchObject({ sent: true });
		vi.mocked(reserveProactiveMessage).mockResolvedValueOnce({ allowed: false, reason: "daily_cap" } as never);
		vi.mocked(appendConversationMessage).mockClear();
		const capped = await run({ origin: "proactive", conversationId: null, calls: [toolCall("notify_user", { message: "Outra." }), done] });
		expect(appendConversationMessage).not.toHaveBeenCalled();
		expect(JSON.parse(capped.results[0]!.summary)).toMatchObject({ sent: false, reason: "daily_cap" });
	});

	it("schedule_followup roda de verdade e o resultado volta ao modelo", async () => {
		const { results } = await run({
			calls: [toolCall("schedule_followup", { when: "daqui a 3 dias", note: "Prova de cálculo" }), done],
		});
		expect(createFollowup).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1", botId: "bot-1", note: "Prova de cálculo", kind: "reminder", source: "chat", sourceRunId: "run-1" }),
		);
		expect(results[0]).toMatchObject({ name: "schedule_followup", ok: true });
		expect(JSON.parse(results[0]!.summary)).toMatchObject({ scheduled: true });
	});

	it("when inválido volta como erro da tool (ok:false), não como sucesso", async () => {
		const { results } = await run({ calls: [toolCall("schedule_followup", { when: "quando der", note: "x" }), done] });
		expect(results[0]).toMatchObject({ name: "schedule_followup", ok: false });
		expect(results[0]!.summary).toMatch(/when inválido/);
	});
});

describe("follow-up autônomo (o bot volta sozinho, em silêncio)", () => {
	const phrases: Array<[string, string, string]> = [
		["o pedido do cliente X deve chegar essa semana", "sexta 17h", "Check in the ERP whether the order of customer X has arrived; report only if it arrived or is late."],
		["a NF deve sair amanhã", "amanhã 16h", "Check whether the NF (invoice) was issued; report only if it was issued or is still missing."],
		["o fornecedor ficou de responder até sexta", "sexta 18h", "Check whether the supplier answered by Friday; report the answer or that it is still pending."],
	];

	it("o prompt do chat traz a regra autônoma", async () => {
		const { systems } = await run({ message: "o pedido do cliente X deve chegar essa semana", calls: [done] });
		expect(systems.some((text) => text.includes("never ask permission and never announce it"))).toBe(true);
	});

	for (const [message, when, note] of phrases) {
		it(`replay: "${message}" agenda uma verificação (check) sem card, sem mensagem e sem avisar`, async () => {
			vi.mocked(createFollowup).mockClear();
			const { results, eventTypes } = await run({ message, calls: [toolCall("schedule_followup", { when, note, inferred: true }), done] });
			expect(createFollowup).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", botId: "bot-1", kind: "check", source: "chat", note }));
			expect(results[0]).toMatchObject({ name: "schedule_followup", ok: true });
			const body = JSON.parse(results[0]!.summary);
			expect(body).toMatchObject({ scheduled: true, kind: "check" });
			expect(body.note).toMatch(/Do NOT mention it to the user/);
			expect(eventTypes).not.toContain("routine");
			expect(vi.mocked(appendConversationMessage)).not.toHaveBeenCalled();
			expect(vi.mocked(appendRoutineProposalCard)).not.toHaveBeenCalled();
		});
	}

	it("inferred força kind=check mesmo que o modelo mande reminder", async () => {
		vi.mocked(createFollowup).mockClear();
		await run({ calls: [toolCall("schedule_followup", { when: "amanhã 9h", note: "x", kind: "reminder", inferred: true }), done] });
		expect(createFollowup).toHaveBeenCalledWith(expect.objectContaining({ kind: "check" }));
	});

	it("conversa fiada (negativo): sem tool, nada agendado", async () => {
		vi.mocked(createFollowup).mockClear();
		await run({ message: "bom dia, tudo bem?", calls: [done] });
		expect(createFollowup).not.toHaveBeenCalled();
	});

	it("teto: com 5 verificações autônomas abertas não agenda outra e manda não avisar", async () => {
		vi.mocked(createFollowup).mockClear();
		const open = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, kind: "check", source: "chat", note: `n${i}`, dueAt: new Date(Date.now() + 86_400_000), stages: [] }));
		vi.mocked(listFollowups).mockResolvedValueOnce(open as never);
		const { results } = await run({ calls: [toolCall("schedule_followup", { when: "amanhã 9h", note: "mais um", inferred: true }), done] });
		expect(createFollowup).not.toHaveBeenCalled();
		expect(JSON.parse(results[0]!.summary)).toMatchObject({ scheduled: false, reason: "inferred_limit" });
	});

	it("pedido explícito (sem inferred) continua confirmando ao usuário", async () => {
		const { results } = await run({ calls: [toolCall("schedule_followup", { when: "amanhã 9h", note: "me lembra do dentista" }), done] });
		expect(JSON.parse(results[0]!.summary).note).toMatch(/Confirm to the user/);
	});

	it("'o que você ficou de conferir?' lista e o usuário pode pedir para cancelar, pelo chat", async () => {
		const item = { id: "f9", kind: "check", source: "chat", note: "Ver se o pedido do cliente X chegou", dueAt: new Date(Date.now() + 86_400_000), stages: [] };
		vi.mocked(listFollowups).mockResolvedValue([item] as never);
		const listed = await run({ message: "o que você ficou de conferir?", calls: [toolCall("list_followups", {}), done] });
		expect(listed.results[0]!.summary).toContain("f9");
		expect(listed.results[0]!.summary).toContain("pedido do cliente X");
		const cancelled = await run({ message: "esquece o do cliente X", calls: [toolCall("cancel_followup", { id: "cliente X" }), done] });
		expect(cancelFollowup).toHaveBeenCalledWith("user-1", "f9", "bot-1");
		expect(cancelled.results[0]).toMatchObject({ ok: true });
		vi.mocked(listFollowups).mockResolvedValue([]);
	});
});

/** Decisões da reflexão diária (origin proativa, sem conversa) com LLM e Jev simulados. */
describe("reflexão: o que o modelo decide e o que o servidor faz", () => {
	const reflection = { origin: "proactive", conversationId: null, message: "[PROACTIVE REFLECTION]" } as const;
	const routineCall = toolCall("suggest_routine", { name: "Resumo da semana", prompt: "Resuma a semana", cron: "0 8 * * 1" });

	it("nada a fazer: termina em silêncio (nenhuma mensagem, card ou lembrete)", async () => {
		vi.clearAllMocks();
		await run({ ...reflection, calls: [{ model: "test-model", message: { role: "assistant", content: "DONE" } }] });
		expect(appendConversationMessage).not.toHaveBeenCalled();
		expect(appendRoutineProposalCard).not.toHaveBeenCalled();
		expect(createFollowup).not.toHaveBeenCalled();
		expect(reserveProactiveMessage).not.toHaveBeenCalled();
	});

	it("Sugerir: grava só o card pendente (e conta no teto) — a rotina não é criada", async () => {
		vi.clearAllMocks();
		const { results } = await run({ ...reflection, routineMode: "suggest", calls: [routineCall, done] });
		expect(createRoutineFromProposal).not.toHaveBeenCalled();
		expect(reserveProactiveMessage).toHaveBeenCalledTimes(1);
		expect(appendRoutineProposalCard).toHaveBeenCalledWith(
			"conv-1",
			expect.objectContaining({ kind: "routine-proposal", mode: "suggest", status: "pending", spec: expect.objectContaining({ name: "Resumo da semana", schedule: "0 8 * * 1" }) }),
		);
		expect(JSON.parse(results[0]!.summary)).toMatchObject({ proposed: true });
	});

	it("Automático: cria a rotina (do bot), sincroniza o agendador e grava o card com Desfazer", async () => {
		vi.clearAllMocks();
		const onRoutineMutated = vi.fn(async () => undefined);
		const { results } = await run({ ...reflection, routineMode: "auto", onRoutineMutated, calls: [routineCall, done] });
		expect(createRoutineFromProposal).toHaveBeenCalledWith("user-1", "bot-1", expect.objectContaining({ name: "Resumo da semana" }));
		expect(onRoutineMutated).toHaveBeenCalledWith(expect.objectContaining({ id: "r-new" }));
		expect(appendRoutineProposalCard).toHaveBeenCalledWith("conv-1", expect.objectContaining({ mode: "auto", status: "pending", routineId: "r-new" }));
		expect(JSON.parse(results[0]!.summary)).toMatchObject({ created: true, mode: "auto" });
	});

	it("dedupe: rotina já existente não gera card nem criação, nem gasta o teto", async () => {
		vi.clearAllMocks();
		vi.mocked(listRoutines).mockResolvedValueOnce([{ name: "Resumo da semana", prompt: "x", schedule: "0 9 * * 1" }] as never);
		const { results } = await run({ ...reflection, routineMode: "auto", calls: [routineCall, done] });
		expect(createRoutineFromProposal).not.toHaveBeenCalled();
		expect(appendRoutineProposalCard).not.toHaveBeenCalled();
		expect(reserveProactiveMessage).not.toHaveBeenCalled();
		expect(JSON.parse(results[0]!.summary)).toMatchObject({ created: false, reason: "similar_routine_exists" });
	});

	it("teto/silêncio já estourados: a ideia de rotina nem é criada", async () => {
		vi.clearAllMocks();
		vi.mocked(reserveProactiveMessage).mockResolvedValueOnce({ allowed: false, reason: "quiet_hours" } as never);
		const { results } = await run({ ...reflection, routineMode: "auto", calls: [routineCall, done] });
		expect(createRoutineFromProposal).not.toHaveBeenCalled();
		expect(appendRoutineProposalCard).not.toHaveBeenCalled();
		expect(JSON.parse(results[0]!.summary)).toMatchObject({ sent: false, reason: "quiet_hours" });
	});

	it("o Jev bloqueia uma mensagem que não vale interromper (modo on, abaixo de 0,6)", async () => {
		vi.clearAllMocks();
		const seen: string[] = [];
		const queue = [toolCall("notify_user", { message: "Bom dia, tudo bem?" }), done];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("x");
			},
			sandboxEnabled: false,
			model: "test-model",
			apiKey: "test",
			messages: [{ role: "user", content: "[PROACTIVE REFLECTION]" }],
			botId: "bot-1",
			userId: "user-1",
			runId: "run-1",
			origin: "proactive",
			maxSteps: 3,
			proactive: { settings },
			jev: {
				modes: { proactive: "on" },
				ask: async (request) => {
					seen.push(JSON.stringify(request.questions));
					return { model: "jev", answers: { worth_interrupting: 0.2 }, durationMs: 1 };
				},
			},
			onEvent: () => undefined,
			streamChat: async () => queue.shift()!,
		});
		expect(seen[0]).toContain("worth interrupting");
		expect(appendConversationMessage).not.toHaveBeenCalled();
		expect(reserveProactiveMessage).not.toHaveBeenCalled();
	});
});
