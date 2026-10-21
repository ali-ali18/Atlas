import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROACTIVE_SETTINGS, type ProactiveSettings } from "@workspace/shared";
import type { JevRuntime } from "../jev/decide.js";
import {
	PROACTIVE_JEV_THRESHOLD,
	executeCancelFollowup,
	executeListFollowups,
	executeNotifyUser,
	executeRescheduleFollowup,
	executeScheduleFollowup,
	executeUserPush,
	notifyUserPushTool,
	type UserPushContext,
	SCHEDULE_FOLLOWUP_TOOL,
	executeSuggestRoutine,
	proactiveToolsFor,
	type ProactiveToolContext,
	type ProactiveToolDeps,
} from "./proactive.js";

/** Tools do modo proativo com db e Jev simulados: fuso, silêncio, teto, dedupe, Sugerir x Automático. */

// Terça 2026-10-13, 12:00 em São Paulo.
const NOON = new Date("2026-10-13T15:00:00.000Z");
const QUIET_NIGHT = new Date("2026-10-14T02:00:00.000Z"); // 23:00 em SP

function settings(patch: Partial<ProactiveSettings> = {}): ProactiveSettings {
	return { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, ...patch };
}

function ctx(patch: Partial<ProactiveToolContext> = {}): ProactiveToolContext {
	return {
		userId: "user-1",
		botId: "bot-1",
		runId: "run-1",
		origin: "chat",
		conversationId: "conv-1",
		settings: settings(),
		reflection: false,
		actions: { used: 0 },
		now: () => NOON,
		log: () => undefined,
		...patch,
	};
}

function makeDeps(overrides: Partial<ProactiveToolDeps> = {}) {
	const followups: Array<Record<string, unknown>> = [];
	const cards: Array<Record<string, unknown>> = [];
	const messages: string[] = [];
	const deps: ProactiveToolDeps = {
		createFollowup: vi.fn(async (input) => {
			followups.push(input as never);
			return { followup: { id: `f${followups.length}`, dueAt: input.dueAt, requestedFor: input.requestedFor, note: input.note, kind: input.kind } as never, duplicate: false };
		}),
		listFollowups: vi.fn(async () => []),
		cancelFollowup: vi.fn(async () => true),
		rescheduleOwnedFollowup: vi.fn(async (input) => ({
			ok: true as const,
			followup: { id: input.followupId, dueAt: new Date("2026-10-14T12:00:00Z"), note: "x", kind: "reminder", stages: [{ at: "2026-10-14T12:00:00.000Z", firedAt: null }] } as never,
			movedForQuietHours: false,
			requestedFor: new Date("2026-10-14T12:00:00Z"),
		})),
		listRoutines: vi.fn(async () => []),
		createRoutineFromProposal: vi.fn(async (_u, _b, spec) => ({
			routine: { id: "r-new", name: spec.name, enabled: true, schedule: spec.schedule ?? null, timezone: spec.timezone, triggerType: "cron" } as never,
		})),
		appendRoutineProposalCard: vi.fn(async (_c, card) => {
			cards.push(card as never);
			return "msg-1";
		}),
		findRecentProposalByName: vi.fn(async () => null),
		getBotConversationId: vi.fn(async () => "conv-1"),
		appendMessage: vi.fn(async (_c, _r, text) => {
			messages.push(text);
			return {} as never;
		}),
		reserve: vi.fn(async () => ({ allowed: true as const })),
		recordEvent: vi.fn(async () => undefined),
		...overrides,
	};
	return { deps, followups, cards, messages };
}

function jev(mode: "off" | "shadow" | "on", probability: number | "throw"): JevRuntime {
	return {
		modes: { proactive: mode },
		ask: async () => {
			if (probability === "throw") throw new Error("down");
			return { model: "jev", answers: { worth_interrupting: probability }, durationMs: 1 };
		},
	};
}

describe("proactiveToolsFor", () => {
	const names = (origin: string, hasConversation: boolean) => proactiveToolsFor({ origin, hasConversation }).map((t) => t.function.name);

	it("chat: lembretes e ideia de rotina, nunca notify_user", () => {
		expect(names("chat", true)).toEqual(["schedule_followup", "list_followups", "cancel_followup", "reschedule_followup", "suggest_routine"]);
	});
	it("reflexão (sem conversa): inclui notify_user, não cancela", () => {
		expect(names("proactive", false)).toEqual(["schedule_followup", "list_followups", "suggest_routine", "notify_user"]);
	});
	it("run de lembrete (proativo com conversa): não pode falar sozinho nem criar rotina", () => {
		expect(names("proactive", true)).toEqual(["schedule_followup", "list_followups", "cancel_followup", "reschedule_followup"]);
	});
	it("rotina, webhook e bot não recebem nada", () => {
		for (const origin of ["routine", "webhook", "bot", "subagent"]) expect(names(origin, true)).toEqual([]);
	});
});

describe("schedule_followup", () => {
	it("resolve 'amanhã 9h' no fuso do usuário e agenda", async () => {
		const { deps, followups } = makeDeps();
		const out = await executeScheduleFollowup({ when: "amanhã 9h", note: "Prova de cálculo" }, ctx(), deps);
		expect((followups[0]!.dueAt as Date).toISOString()).toBe("2026-10-14T12:00:00.000Z");
		expect(followups[0]).toMatchObject({ userId: "user-1", botId: "bot-1", kind: "reminder", source: "chat", sourceRunId: "run-1" });
		const body = JSON.parse(out.summary);
		expect(body).toMatchObject({ scheduled: true, kind: "reminder" });
		expect(body.at).toMatch(/14\/10 às 09:00/);
		expect(body.movedForQuietHours).toBeUndefined();
	});

	it("respeita o fuso configurado (Nova York)", async () => {
		const { deps, followups } = makeDeps();
		await executeScheduleFollowup({ when: "amanhã 9h", note: "x" }, ctx({ settings: settings({ timezone: "America/New_York" }) }), deps);
		expect((followups[0]!.dueAt as Date).toISOString()).toBe("2026-10-14T13:00:00.000Z");
	});

	it("empurra para o fim do silêncio e avisa", async () => {
		const { deps, followups } = makeDeps();
		const out = await executeScheduleFollowup({ when: "amanhã 6h", note: "Acordar cedo" }, ctx(), deps);
		// 06:00 SP cai no silêncio (22-08): vai para 08:00 SP = 11:00Z
		expect((followups[0]!.dueAt as Date).toISOString()).toBe("2026-10-14T11:00:00.000Z");
		expect((followups[0]!.requestedFor as Date).toISOString()).toBe("2026-10-14T09:00:00.000Z");
		expect(JSON.parse(out.summary)).toMatchObject({ movedForQuietHours: true });
	});

	it("when inválido, passado ou note vazio viram erro honesto", async () => {
		const { deps } = makeDeps();
		await expect(executeScheduleFollowup({ when: "quando der", note: "x" }, ctx(), deps)).rejects.toThrow(/when inválido/);
		await expect(executeScheduleFollowup({ when: "2020-01-01T10:00", note: "x" }, ctx(), deps)).rejects.toThrow(/futuro/);
		await expect(executeScheduleFollowup({ when: "amanhã", note: "  " }, ctx(), deps)).rejects.toThrow(/note/);
	});

	it("kind=check e origem reflexão ficam registrados", async () => {
		const { deps, followups } = makeDeps();
		await executeScheduleFollowup({ when: "dia 20", note: "Ver o resultado da licitação", kind: "check" }, ctx({ reflection: true, origin: "proactive", conversationId: undefined }), deps);
		expect(followups[0]).toMatchObject({ kind: "check", source: "reflection" });
	});

	it("duplicado devolve o existente sem contar como ação", async () => {
		const { deps } = makeDeps({
			createFollowup: vi.fn(async (input) => ({ followup: { id: "f0", dueAt: input.dueAt, requestedFor: input.requestedFor } as never, duplicate: true })),
		});
		const c = ctx({ reflection: true });
		const out = await executeScheduleFollowup({ when: "amanhã", note: "x" }, c, deps);
		expect(JSON.parse(out.summary)).toMatchObject({ scheduled: false, alreadyScheduled: true });
		expect(c.actions.used).toBe(0);
	});

	it("reflexão: no máximo 3 ações por execução", async () => {
		const { deps } = makeDeps();
		const c = ctx({ reflection: true, origin: "proactive", conversationId: undefined });
		for (let i = 0; i < 3; i += 1) await executeScheduleFollowup({ when: `daqui a ${i + 2} dias`, note: `Nota ${i}` }, c, deps);
		const out = await executeScheduleFollowup({ when: "daqui a 9 dias", note: "Nota 4" }, c, deps);
		expect(JSON.parse(out.summary)).toMatchObject({ done: false, reason: "action_limit" });
		expect(deps.createFollowup).toHaveBeenCalledTimes(3);
	});

	it("sem usuário/bot falha", async () => {
		const { deps } = makeDeps();
		await expect(executeScheduleFollowup({ when: "amanhã", note: "x" }, ctx({ userId: "default" }), deps)).rejects.toThrow(/Sem usuário/);
	});
});

describe("list_followups / cancel_followup", () => {
	const items = [
		{ id: "f1", note: "Pagar o boleto", kind: "reminder", dueAt: new Date("2026-10-14T12:00:00Z") },
		{ id: "f2", note: "Ligar para o dentista", kind: "reminder", dueAt: new Date("2026-10-15T12:00:00Z") },
	];

	it("lista com id, horário e tipo", async () => {
		const { deps } = makeDeps({ listFollowups: vi.fn(async () => items as never) });
		const out = await executeListFollowups({}, ctx(), deps);
		expect(out.summary).toContain("f1 |");
		expect(out.summary).toContain("Ligar para o dentista");
	});

	it("vazio é dito claramente", async () => {
		const { deps } = makeDeps();
		expect((await executeListFollowups({}, ctx(), deps)).summary).toMatch(/Nenhum/);
	});

	it("cancela por id ou por trecho; ambíguo e inexistente são erro", async () => {
		const { deps } = makeDeps({ listFollowups: vi.fn(async () => items as never) });
		await executeCancelFollowup({ id: "dentista" }, ctx(), deps);
		expect(deps.cancelFollowup).toHaveBeenCalledWith("user-1", "f2", "bot-1");
		await executeCancelFollowup({ id: "f1" }, ctx(), deps);
		expect(deps.cancelFollowup).toHaveBeenCalledWith("user-1", "f1", "bot-1");
		await expect(executeCancelFollowup({ id: "xyz" }, ctx(), deps)).rejects.toThrow(/Nenhum/);
		await expect(executeCancelFollowup({ id: "o" }, ctx(), deps)).rejects.toThrow(/Mais de um/);
	});
});

describe("lembretes escalonados (um lembrete, vários avisos)", () => {
	it("a descrição manda um lembrete por assunto, escalonado, e não cita o produto", () => {
		const description = SCHEDULE_FOLLOWUP_TOOL.function.description ?? "";
		expect(description).toMatch(/never schedule a single reminder close to the due date/);
		expect(description).toMatch(/ONE follow-up per subject/);
		expect(description).toMatch(/every 1-2 weeks/);
		expect(description).toMatch(/2-3 days before/);
		expect(description).not.toMatch(/atlas/i);
	});

	it("stages cria UM lembrete com vários avisos, ordenados, fora do silêncio", async () => {
		const { deps, followups } = makeDeps();
		const out = await executeScheduleFollowup(
			{ note: "Entrega do relatório", stages: ["2026-11-11T09:00", "amanhã 9h", "2026-10-30T23:00"] },
			ctx(),
			deps,
		);
		expect(deps.createFollowup).toHaveBeenCalledTimes(1);
		const input = followups[0] as { dueAt: Date; stages: Date[] };
		expect(input.stages.map((d) => d.toISOString())).toEqual(["2026-10-14T12:00:00.000Z", "2026-10-31T11:00:00.000Z", "2026-11-11T12:00:00.000Z"]);
		expect(input.dueAt.toISOString()).toBe("2026-10-14T12:00:00.000Z");
		const body = JSON.parse(out.summary);
		expect(body.stages).toHaveLength(3);
		expect(body.movedForQuietHours).toBe(true);
	});

	it("mais de 4 avisos é erro; passado também", async () => {
		const { deps } = makeDeps();
		await expect(executeScheduleFollowup({ note: "x", stages: ["amanhã", "dia 20", "dia 21", "dia 22", "dia 23"] }, ctx(), deps)).rejects.toThrow(/no máximo 4/);
		await expect(executeScheduleFollowup({ note: "x", stages: ["2026-10-01T09:00"] }, ctx(), deps)).rejects.toThrow(/stages inválido/);
	});

	it("deadline sem stages: o servidor escalona (início, meio, 2 dias antes), num lembrete só", async () => {
		const { deps, followups } = makeDeps();
		const out = await executeScheduleFollowup({ note: "Entrega", deadline: "2026-11-13" }, ctx(), deps);
		expect(deps.createFollowup).toHaveBeenCalledTimes(1);
		const stages = (followups[0] as { stages: Date[] }).stages;
		expect(stages.length).toBeGreaterThanOrEqual(3);
		expect(stages.length).toBeLessThanOrEqual(4);
		expect(stages[0]!.toISOString()).toBe("2026-10-14T12:00:00.000Z");
		expect(stages.at(-1)!.toISOString()).toBe("2026-11-11T12:00:00.000Z");
		expect(JSON.parse(out.summary).stages.length).toBe(stages.length);
	});

	it("when único continua igual (compatível) e sem when/stages/deadline é erro", async () => {
		const { deps, followups } = makeDeps();
		const body = JSON.parse((await executeScheduleFollowup({ when: "amanhã 9h", note: "Entrega" }, ctx(), deps)).summary);
		expect(body.stages).toBeUndefined();
		expect((followups[0] as { stages: Date[] }).stages).toHaveLength(1);
		await expect(executeScheduleFollowup({ note: "Entrega" }, ctx(), deps)).rejects.toThrow(/Informe "when"/);
	});

	it("list_followups mostra os avisos e o andamento", async () => {
		const items = [
			{
				id: "f1",
				note: "Entrega",
				kind: "reminder",
				dueAt: new Date("2026-10-30T12:00:00Z"),
				stages: [
					{ at: "2026-10-15T12:00:00.000Z", firedAt: "2026-10-15T12:01:00.000Z" },
					{ at: "2026-10-30T12:00:00.000Z", firedAt: null },
					{ at: "2026-11-11T12:00:00.000Z", firedAt: null },
				],
			},
			{ id: "f2", note: "Simples", kind: "reminder", dueAt: new Date("2026-10-31T12:00:00Z"), stages: [{ at: "2026-10-31T12:00:00.000Z", firedAt: null }] },
		];
		const { deps } = makeDeps({ listFollowups: vi.fn(async () => items as never) });
		const out = (await executeListFollowups({}, ctx(), deps)).summary;
		expect(out).toMatch(/f1 .*notices 2\/3:.*\(sent\)/);
		expect(out.split("\n")[1]).not.toMatch(/notices/);
	});
});

describe("reschedule_followup", () => {
	const items = [
		{ id: "f1", note: "Pagar o boleto", kind: "reminder", dueAt: new Date("2026-10-14T12:00:00Z") },
		{ id: "f2", note: "Ligar para o dentista", kind: "reminder", dueAt: new Date("2026-10-15T12:00:00Z") },
	];

	it("move por id ou trecho, sem criar outro", async () => {
		const { deps } = makeDeps({ listFollowups: vi.fn(async () => items as never) });
		const out = await executeRescheduleFollowup({ id: "dentista", when: "amanhã 9h" }, ctx(), deps);
		expect(deps.rescheduleOwnedFollowup).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", botId: "bot-1", followupId: "f2", when: "amanhã 9h" }));
		await executeRescheduleFollowup({ id: "f2", when: "amanhã 9h", stage: 2 }, ctx(), deps);
		expect(deps.rescheduleOwnedFollowup).toHaveBeenLastCalledWith(expect.objectContaining({ followupId: "f2", stage: 2 }));
		expect(deps.createFollowup).not.toHaveBeenCalled();
		expect(JSON.parse(out.summary)).toMatchObject({ rescheduled: true, id: "f2" });
	});

	it("avisa quando o silêncio empurrou o horário", async () => {
		const { deps } = makeDeps({
			listFollowups: vi.fn(async () => items as never),
			rescheduleOwnedFollowup: vi.fn(async () => ({
				ok: true as const,
				followup: { id: "f1", dueAt: new Date("2026-10-15T11:00:00Z"), stages: [{ at: "2026-10-15T11:00:00.000Z", firedAt: null }] } as never,
				movedForQuietHours: true,
				requestedFor: new Date("2026-10-15T02:00:00Z"),
			})),
		});
		const body = JSON.parse((await executeRescheduleFollowup({ id: "f1", when: "amanhã 23h" }, ctx(), deps)).summary);
		expect(body.movedForQuietHours).toBe(true);
	});

	it("passado, ambíguo e inexistente são erro", async () => {
		const { deps } = makeDeps({ listFollowups: vi.fn(async () => items as never) });
		await expect(executeRescheduleFollowup({ id: "f1", when: "2026-10-01T09:00" }, ctx(), deps)).rejects.toThrow(/when inválido/);
		await expect(executeRescheduleFollowup({ id: "o", when: "amanhã 9h" }, ctx(), deps)).rejects.toThrow(/Mais de um/);
		await expect(executeRescheduleFollowup({ id: "xyz", when: "amanhã 9h" }, ctx(), deps)).rejects.toThrow(/Nenhum/);
		expect(deps.rescheduleOwnedFollowup).not.toHaveBeenCalled();
	});
});

describe("suggest_routine", () => {
	const args = { name: "Resumo da semana", prompt: "Resuma minha semana", cron: "0 8 * * 1" };

	it("Sugerir (padrão): grava só o card pendente, não cria rotina", async () => {
		const { deps, cards } = makeDeps();
		const out = await executeSuggestRoutine(args, ctx(), deps);
		expect(deps.createRoutineFromProposal).not.toHaveBeenCalled();
		expect(cards[0]).toMatchObject({ kind: "routine-proposal", mode: "suggest", status: "pending", spec: { name: "Resumo da semana", schedule: "0 8 * * 1", timezone: "America/Sao_Paulo" } });
		expect(cards[0]!.routineId).toBeUndefined();
		expect(JSON.parse(out.summary)).toMatchObject({ proposed: true, mode: "suggest" });
	});

	it("Automático: cria a rotina, sincroniza o agendador e grava o card com o id", async () => {
		const { deps, cards } = makeDeps();
		const onRoutineMutated = vi.fn(async () => undefined);
		const out = await executeSuggestRoutine(args, ctx({ settings: settings({ routineMode: "auto" }), onRoutineMutated }), deps);
		expect(deps.createRoutineFromProposal).toHaveBeenCalledWith("user-1", "bot-1", expect.objectContaining({ name: "Resumo da semana" }));
		expect(onRoutineMutated).toHaveBeenCalledWith(expect.objectContaining({ id: "r-new" }));
		expect(cards[0]).toMatchObject({ mode: "auto", status: "pending", routineId: "r-new" });
		expect(JSON.parse(out.summary)).toMatchObject({ created: true, mode: "auto" });
	});

	it("intervalo em vez de cron", async () => {
		const { deps, cards } = makeDeps();
		await executeSuggestRoutine({ name: "Conferir pedidos", prompt: "Veja os pedidos", every_minutes: 120 }, ctx(), deps);
		expect(cards[0]!.spec).toMatchObject({ everyMinutes: 120 });
	});

	it("dedupe: rotina parecida existente ou proposta anterior (mesmo recusada) não repete", async () => {
		const existing = makeDeps({ listRoutines: vi.fn(async () => [{ name: "Resumo da semana", prompt: "x", schedule: "0 9 * * 1" }] as never) });
		const a = await executeSuggestRoutine(args, ctx(), existing.deps);
		expect(JSON.parse(a.summary)).toMatchObject({ created: false, reason: "similar_routine_exists" });
		expect(existing.cards).toHaveLength(0);

		const declined = makeDeps({ findRecentProposalByName: vi.fn(async () => ({ status: "declined" }) as never) });
		const b = await executeSuggestRoutine(args, ctx(), declined.deps);
		expect(JSON.parse(b.summary)).toMatchObject({ reason: "already_proposed", status: "declined" });
		expect(declined.cards).toHaveLength(0);
	});

	it("valida cron, intervalo e campos obrigatórios", async () => {
		const { deps } = makeDeps();
		await expect(executeSuggestRoutine({ ...args, cron: "toda segunda" }, ctx(), deps)).rejects.toThrow(/cron inválido/);
		await expect(executeSuggestRoutine({ name: "x", prompt: "y", every_minutes: 1 }, ctx(), deps)).rejects.toThrow(/every_minutes/);
		await expect(executeSuggestRoutine({ name: "x", prompt: "y" }, ctx(), deps)).rejects.toThrow(/cron/);
		await expect(executeSuggestRoutine({ ...args, every_minutes: 30 }, ctx(), deps)).rejects.toThrow(/não os dois/);
		await expect(executeSuggestRoutine({ ...args, name: "" }, ctx(), deps)).rejects.toThrow(/name/);
	});

	it("na reflexão passa pelo teto/silêncio ANTES de criar qualquer coisa", async () => {
		const blocked = makeDeps({ reserve: vi.fn(async () => ({ allowed: false as const, reason: "daily_cap" as const })) });
		const out = await executeSuggestRoutine(args, ctx({ reflection: true, settings: settings({ routineMode: "auto" }), origin: "proactive", conversationId: undefined }), blocked.deps);
		expect(JSON.parse(out.summary)).toMatchObject({ sent: false, reason: "daily_cap" });
		expect(blocked.deps.createRoutineFromProposal).not.toHaveBeenCalled();
		expect(blocked.cards).toHaveLength(0);
	});

	it("no chat (usuário presente) não consome o teto diário", async () => {
		const { deps } = makeDeps();
		await executeSuggestRoutine(args, ctx(), deps);
		expect(deps.reserve).not.toHaveBeenCalled();
	});
});

describe("notify_user", () => {
	const reflectionCtx = (patch: Partial<ProactiveToolContext> = {}) =>
		ctx({ reflection: true, origin: "proactive", conversationId: undefined, ...patch });

	it("só existe na reflexão", async () => {
		const { deps } = makeDeps();
		await expect(executeNotifyUser({ message: "oi" }, ctx(), deps)).rejects.toThrow(/reflexão/);
	});

	it("sem Jev: reserva (silêncio + teto) e grava a mensagem na conversa do bot", async () => {
		const { deps, messages } = makeDeps();
		const out = await executeNotifyUser({ message: "A prova é amanhã às 8h." }, reflectionCtx(), deps);
		expect(deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", botId: "bot-1" }));
		expect(deps.getBotConversationId).toHaveBeenCalledWith("bot-1", "user-1");
		expect(messages).toEqual(["A prova é amanhã às 8h."]);
		expect(JSON.parse(out.summary)).toMatchObject({ sent: true });
	});

	it("Jev ligado abaixo do limiar bloqueia e não reserva o teto", async () => {
		const { deps, messages } = makeDeps();
		const out = await executeNotifyUser({ message: "Bom dia!" }, reflectionCtx({ jev: jev("on", PROACTIVE_JEV_THRESHOLD - 0.01) }), deps);
		expect(JSON.parse(out.summary)).toMatchObject({ sent: false, reason: "jev" });
		expect(messages).toHaveLength(0);
		expect(deps.reserve).not.toHaveBeenCalled();
	});

	it("Jev ligado no limiar ou acima libera", async () => {
		const { deps, messages } = makeDeps();
		await executeNotifyUser({ message: "Vence hoje." }, reflectionCtx({ jev: jev("on", PROACTIVE_JEV_THRESHOLD) }), deps);
		expect(messages).toEqual(["Vence hoje."]);
	});

	it("Jev em shadow só observa; Jev indisponível cai no teto + julgamento do modelo", async () => {
		const shadow = makeDeps();
		await executeNotifyUser({ message: "a" }, reflectionCtx({ jev: jev("shadow", 0.01) }), shadow.deps);
		expect(shadow.messages).toEqual(["a"]);
		const down = makeDeps();
		await executeNotifyUser({ message: "b" }, reflectionCtx({ jev: jev("on", "throw") }), down.deps);
		expect(down.messages).toEqual(["b"]);
		const off = makeDeps();
		await executeNotifyUser({ message: "c" }, reflectionCtx({ jev: jev("off", 0) }), off.deps);
		expect(off.messages).toEqual(["c"]);
	});

	it("silêncio e teto diário bloqueiam no servidor", async () => {
		for (const reason of ["quiet_hours", "daily_cap"] as const) {
			const { deps, messages } = makeDeps({ reserve: vi.fn(async () => ({ allowed: false as const, reason })) });
			const out = await executeNotifyUser({ message: "x" }, reflectionCtx({ now: () => (reason === "quiet_hours" ? QUIET_NIGHT : NOON) }), deps);
			expect(JSON.parse(out.summary)).toMatchObject({ sent: false, reason });
			expect(messages).toHaveLength(0);
		}
	});

	it("mensagem vazia ou longa demais é erro; sem conversa não envia", async () => {
		const { deps } = makeDeps();
		await expect(executeNotifyUser({ message: " " }, reflectionCtx(), deps)).rejects.toThrow(/message/);
		await expect(executeNotifyUser({ message: "x".repeat(800) }, reflectionCtx(), deps)).rejects.toThrow(/longa/);
		const noConv = makeDeps({ getBotConversationId: vi.fn(async () => null) });
		await expect(executeNotifyUser({ message: "x" }, reflectionCtx(), noConv.deps)).rejects.toThrow(/conversa/);
	});

	it("o teto de ações da reflexão também vale para mensagens", async () => {
		const { deps, messages } = makeDeps();
		const c = reflectionCtx();
		c.actions.used = 3;
		const out = await executeNotifyUser({ message: "x" }, c, deps);
		expect(JSON.parse(out.summary)).toMatchObject({ reason: "action_limit" });
		expect(messages).toHaveLength(0);
	});
});

describe("notify_user como push avulso (rotina importante / chat)", () => {
	function pushCtx(patch: Partial<UserPushContext> = {}) {
		const sent: string[] = [];
		const c: UserPushContext = { mode: "routine", send: async (t) => void sent.push(t), sent: { used: 0 }, now: () => NOON, log: () => undefined, ...patch };
		return { c, sent };
	}

	it("manda o push uma vez e recusa a segunda chamada", async () => {
		const { c, sent } = pushCtx();
		const first = await executeUserPush({ message: "Fatura vence hoje." }, c);
		expect(JSON.parse(first.summary)).toMatchObject({ sent: true });
		const second = await executeUserPush({ message: "Outra coisa." }, c);
		expect(JSON.parse(second.summary)).toMatchObject({ sent: false, reason: "one_per_run" });
		expect(sent).toEqual(["Fatura vence hoje."]);
	});

	it("respeita o silêncio quando configurado e não conta como enviado", async () => {
		const { c, sent } = pushCtx({ quiet: settings(), now: () => QUIET_NIGHT });
		const out = await executeUserPush({ message: "x" }, c);
		expect(JSON.parse(out.summary)).toMatchObject({ sent: false, reason: "quiet_hours" });
		expect(sent).toHaveLength(0);
		expect(c.sent.used).toBe(0);
	});

	it("sem configuração de silêncio, envia a qualquer hora", async () => {
		const { c, sent } = pushCtx({ now: () => QUIET_NIGHT });
		await executeUserPush({ message: "x" }, c);
		expect(sent).toHaveLength(1);
	});

	it("valida mensagem vazia e longa demais", async () => {
		const { c } = pushCtx({ mode: "chat" });
		await expect(executeUserPush({ message: " " }, c)).rejects.toThrow(/message/);
		await expect(executeUserPush({ message: "x".repeat(300) }, c)).rejects.toThrow(/longa/);
	});

	it("o nome é o mesmo da reflexão, com descrição por contexto", () => {
		const routine = notifyUserPushTool("routine").function;
		const chat = notifyUserPushTool("chat").function;
		expect(routine.name).toBe("notify_user");
		expect(chat.name).toBe("notify_user");
		expect(routine.description).not.toBe(chat.description);
		expect(chat.description).toMatch(/final answer/);
	});

	it("a reflexão continua igual: ainda grava a mensagem no chat do bot", async () => {
		const { deps, messages } = makeDeps();
		await executeNotifyUser({ message: "A prova é amanhã." }, ctx({ reflection: true, conversationId: undefined }), deps);
		expect(messages).toEqual(["A prova é amanhã."]);
	});
});
