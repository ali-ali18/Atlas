/**
 * Motor v2 nas origens que antes ficavam só no v1: alerta (`report_alert`), brief "Seu dia" (rotina sem conversa),
 * modo proativo (chat, reflexão e lembrete) e rotina "só importante" (`notify_user`). O MESMO roteiro roda no v1
 * (`engine: "v1"` explícito) e no v2 (`engine: "v2"` + `engineScope: "all"`) e o que fica no Postgres tem de ser igual.
 * Postgres real, rotina e run pelos caminhos reais, modelo roteirizado (sem rede).
 */
import "./env.js";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { integrationSkip } from "./env.js";
import { createApi, createFixture, installFakeLlm, processRun, prisma, sendChat, snapshot, workerConfig, type FakeLlm, type Fixture, type ScriptEntry } from "./harness.js";

let llm: FakeLlm | undefined;
afterEach(() => {
	llm?.restore();
	llm = undefined;
});

type Which = "v1" | "v2";
const WHICH: Which[] = ["v1", "v2"];
const policyFor = (which: Which, extra: Record<string, unknown> = {}) => ({ ...(which === "v2" ? { engine: "v2", engineScope: "all" } : { engine: "v1" }), ...extra });
const proactiveOn = { proactive: { enabled: true, routineMode: "suggest", maxPerDay: 3, quietStart: "00:00", quietEnd: "00:00", timezone: "America/Sao_Paulo" } };

/** Cria a rotina, dispara pelo processador real e processa o run que ela criou. */
async function runRoutine(fx: Fixture, routine: Record<string, unknown>, deps: Parameters<typeof processRun>[1] = {}) {
	const { createRoutine } = await import("@workspace/db");
	const { processExecuteRoutineJob } = await import("../processors/routine.js");
	const created = await createRoutine(fx.userId, { botId: fx.botId, timezone: "America/Sao_Paulo", model: "test/model", ...routine } as never);
	const queued: string[] = [];
	const queue = { add: async (_name: string, data: { runId: string }) => { queued.push(data.runId); return { id: "j1" }; }, getJob: async () => undefined };
	const outcome = await processExecuteRoutineJob({ routineId: created.routine.id, triggeredBy: "manual" } as never, workerConfig, queue as never);
	assert.equal(outcome.status, "running", JSON.stringify(outcome));
	assert.equal(queued.length, 1);
	await processRun(queued[0]!, deps);
	return { ...(await snapshot(queued[0]!)), routineId: created.routine.id };
}

const alertOf = async (routineId: string) => {
	const row = await prisma.routine.findUniqueOrThrow({ where: { id: routineId }, select: { alertJson: true } });
	return (row.alertJson ?? {}) as { active?: boolean; condition?: string; lastSummary?: string };
};
const assistantTexts = (messages: Array<{ role: string; content: string }>) => messages.filter((m) => m.role === "assistant").map((m) => m.content);

describe("alerta: report_alert no v2 deixa o mesmo efeito no banco que no v1", { skip: integrationSkip }, () => {
	const ALERT = { name: "Estoque da canela", prompt: "Confira o estoque da canela", triggerType: "cron", schedule: "0 10 * * *", alert: { condition: "o estoque de canela cair abaixo de 10" } };

	async function check(which: Which, script: ScriptEntry[]) {
		const fx = await createFixture({ policy: policyFor(which) });
		llm = installFakeLlm(script);
		const snap = await runRoutine(fx, ALERT);
		const alert = await alertOf(snap.routineId);
		const requestTools = llm.requests[0]!.toolNames;
		const system = JSON.stringify(llm.requests[0]!.messages.filter((m) => m.role === "system"));
		llm.restore();
		return { snap, alert, requestTools, system, effects: { status: snap.run.status, stopReason: snap.run.stopReason ?? null, active: alert.active ?? false, posted: assistantTexts(snap.messages) } };
	}

	test("a condição vale agora: veredito gravado, alerta ativo e aviso na conversa, igual nos dois motores", async () => {
		const script: ScriptEntry[] = [{ tools: [{ name: "report_alert", args: { triggered: true, summary: "Estoque da canela: 7 un. (mínimo 10)" } }] }, { content: "Verifiquei: abaixo do mínimo." }];
		const v1 = await check("v1", script);
		const v2 = await check("v2", script);
		assert.equal(v1.snap.budget.engine, undefined);
		assert.equal(v2.snap.budget.engine, "v2", "o run do alerta rodou no v2");
		assert.equal(v2.snap.budget.engineProfile, "chat", "alerta é verificação curta: nunca trabalho longo");
		assert.ok(v2.requestTools.includes("report_alert"), "a tool de veredito foi oferecida no v2");
		assert.match(v2.system, /This run is an alert check/);
		assert.deepEqual(v2.effects, v1.effects);
		assert.equal(v2.effects.status, "completed");
		assert.equal(v2.effects.active, true, "o estado do alerta virou ativo");
		assert.ok(v2.effects.posted.length >= 1, "o aviso entrou na conversa");
		assert.match(v2.effects.posted.join("\n"), /canela/i);
	});

	test("a condição não vale: alerta inativo e nada entra na conversa, igual nos dois motores", async () => {
		const script: ScriptEntry[] = [{ tools: [{ name: "report_alert", args: { triggered: false, summary: "Estoque da canela: 25 un." } }] }, { content: "Tudo certo." }];
		const v1 = await check("v1", script);
		const v2 = await check("v2", script);
		assert.equal(v2.snap.budget.engine, "v2");
		assert.deepEqual(v2.effects, v1.effects);
		assert.equal(v2.effects.active, false);
		assert.deepEqual(v2.effects.posted, [], "sem novidade, sem mensagem");
	});

	test("sem veredito (o modelo não conseguiu ler os dados): nada de alerta falso, igual nos dois motores", async () => {
		const script: ScriptEntry[] = [{ content: "Não consegui ler o estoque agora." }];
		const v1 = await check("v1", script);
		const v2 = await check("v2", script);
		assert.deepEqual(v2.effects, v1.effects);
		assert.equal(v2.effects.active, false);
	});

	test("com v2/chat o alerta continua no v1 (só o escopo ampliado ou o padrão sem escolha o levam ao v2)", async () => {
		const fx = await createFixture({ policy: { engine: "v2" } });
		llm = installFakeLlm([{ tools: [{ name: "report_alert", args: { triggered: false, summary: "ok" } }] }, { content: "Ok." }]);
		const snap = await runRoutine(fx, ALERT);
		assert.equal(snap.budget.engine, undefined);
		assert.equal(snap.run.status, "completed");
	});
});

describe("brief 'Seu dia': rotina sem conversa no v2", { skip: integrationSkip }, () => {
	async function brief(which: Which) {
		const fx = await createFixture({ policy: policyFor(which) });
		llm = installFakeLlm([{ content: "Hoje: 2 compromissos e 1 e-mail que precisa de você." }]);
		const { upsertDailyBrief } = await import("@workspace/agent-runtime");
		const { routine } = await upsertDailyBrief({ schedule: "30 7 * * 1-5" }, { userId: fx.userId, botId: fx.botId });
		// O brief herda o modelo do bot na vida real; o bot de teste não tem um, então a rotina leva o do roteiro.
		await prisma.routine.update({ where: { id: routine.id }, data: { model: "test/model" } });
		const { processExecuteRoutineJob } = await import("../processors/routine.js");
		const queued: string[] = [];
		const queue = { add: async (_name: string, data: { runId: string }) => { queued.push(data.runId); return { id: "j1" }; }, getJob: async () => undefined };
		const outcome = await processExecuteRoutineJob({ routineId: routine.id, triggeredBy: "manual" } as never, workerConfig, queue as never);
		assert.equal(outcome.status, "running", JSON.stringify(outcome));
		await processRun(queued[0]!);
		const snap = await snapshot(queued[0]!);
		const conversation = await prisma.conversationMessage.findMany({ where: { conversationId: fx.conversationId }, orderBy: { createdAt: "asc" } });
		const routineRun = await prisma.routineRun.findFirst({ where: { agentRunId: snap.run.id } });
		const request = llm.requests[0]!;
		llm.restore();
		return { snap, request, effects: { status: snap.run.status, conversationId: snap.run.conversationId, posted: assistantTexts(conversation), briefStatus: (routineRun as { briefStatus?: string | null } | null)?.briefStatus ?? null } };
	}

	test("o brief roda sem conversa, só leitura, e é entregue na conversa do bot igual ao v1", async () => {
		const v1 = await brief("v1");
		const v2 = await brief("v2");
		assert.equal(v1.snap.budget.engine, undefined);
		assert.equal(v2.snap.budget.engine, "v2", "o brief rodou no v2");
		assert.equal(v2.snap.budget.engineProfile, "chat");
		assert.equal(v2.snap.run.conversationId, null, "o run do brief nasce sem conversa");
		assert.deepEqual(v2.effects, v1.effects);
		assert.equal(v2.effects.status, "completed");
		assert.deepEqual(v2.effects.posted, ["Hoje: 2 compromissos e 1 e-mail que precisa de você."]);
		for (const gone of ["notify_user", "create_file", "propose_routine", "delegate", "notebook_write", "update_task_list", "web_search", "email_send"]) {
			assert.ok(!v2.request.toolNames.includes(gone), `${gone} não pode aparecer no brief`);
		}
	});
});

describe("rotina 'só importante': notify_user no v2", { skip: integrationSkip }, () => {
	async function important(which: Which) {
		const fx = await createFixture({ policy: policyFor(which) });
		const pushes: Array<{ kind: string; text: string }> = [];
		const notify = async (_userId: string, _conversationId: string, kind: string, text: string) => { pushes.push({ kind, text }); };
		llm = installFakeLlm([{ tools: [{ name: "notify_user", args: { message: "A fatura vence hoje." } }] }, { content: "Resumo: a fatura vence hoje." }]);
		const snap = await runRoutine(fx, { name: "Faturas", prompt: "Veja as faturas do dia", triggerType: "cron", schedule: "0 9 * * *", notify: "important" }, { notify: notify as never });
		const request = llm.requests[0]!;
		const system = JSON.stringify(request.messages.filter((m) => m.role === "system"));
		llm.restore();
		return { snap, request, system, effects: { status: snap.run.status, posted: assistantTexts(snap.messages), pushes } };
	}

	test("a tool só-push aparece, avisa uma vez e o resultado fica na conversa, igual ao v1", async () => {
		const v1 = await important("v1");
		const v2 = await important("v2");
		assert.equal(v2.snap.budget.engine, "v2");
		assert.ok(v2.request.toolNames.includes("notify_user"));
		assert.match(v2.system, /notify only when something matters/);
		assert.deepEqual(v2.effects, v1.effects);
		assert.ok(v2.effects.pushes.some((push) => push.text === "A fatura vence hoje."), JSON.stringify(v2.effects.pushes));
		assert.equal(v2.effects.pushes.filter((push) => push.text === "A fatura vence hoje.").length, 1);
	});
});

describe("modo proativo: chat, lembrete e reflexão no v2", { skip: integrationSkip }, () => {
	async function followupFromChat(which: Which) {
		const fx = await createFixture({ isPrimary: true, policy: policyFor(which, proactiveOn) });
		llm = installFakeLlm([{ tools: [{ name: "schedule_followup", args: { when: "daqui a 3 dias", note: "Prova de cálculo" } }] }, { content: "Agendei um lembrete da prova." }]);
		const { app } = await createApi(fx.userId);
		const sent = await sendChat(app, fx, "semana que vem tenho prova de cálculo");
		assert.equal(sent.status, 202, JSON.stringify(sent.json));
		await processRun(sent.runId);
		const snap = await snapshot(sent.runId);
		const rows = await prisma.botFollowup.findMany({ where: { userId: fx.userId, botId: fx.botId } });
		const request = llm.requests[0]!;
		llm.restore();
		return { snap, request, effects: { status: snap.run.status, followups: rows.map((row) => ({ note: row.note, kind: row.kind, source: row.source, status: row.status })), posted: assistantTexts(snap.messages) } };
	}

	test("chat do bot principal: agenda o lembrete (schedule_followup) com o mesmo efeito do v1", async () => {
		const v1 = await followupFromChat("v1");
		const v2 = await followupFromChat("v2");
		assert.equal(v1.snap.budget.engine, undefined);
		assert.equal(v2.snap.budget.engine, "v2", "o chat com modo proativo ligado rodou no v2");
		assert.ok(v2.request.toolNames.includes("schedule_followup"));
		assert.deepEqual(v2.effects, v1.effects);
		assert.deepEqual(v2.effects.followups, [{ note: "Prova de cálculo", kind: "reminder", source: "chat", status: "pending" }]);
	});

	/** Reflexão (sem conversa) e lembrete (com conversa): o run proativo criado como o db cria. */
	async function proactiveRun(which: Which, kind: "reflection" | "followup", script: ScriptEntry[]) {
		const fx = await createFixture({ isPrimary: true, policy: policyFor(which, proactiveOn) });
		llm = installFakeLlm(script);
		const { createAgentRun, createDetachedProactiveRun } = await import("@workspace/db");
		const objective = kind === "reflection" ? "[PROACTIVE REFLECTION] Revise o que está em aberto." : "A check scheduled earlier. Look at the order status and reply [NO_UPDATE] when nothing changed.";
		// Como o db cria: a reflexão nasce sem conversa; o lembrete roda na conversa do bot, em silêncio.
		const run =
			kind === "reflection"
				? await createDetachedProactiveRun({ userId: fx.userId, botId: fx.botId, model: "test/model", objective, messages: [{ role: "user", content: objective }] })
				: await createAgentRun({
						userId: fx.userId,
						model: "test/model",
						request: { botId: fx.botId, conversationId: fx.conversationId, origin: "proactive", objective, messages: [{ role: "user", content: objective }], silent: true } as never,
					});
		await processRun(run.id);
		const snap = await snapshot(run.id);
		const conversation = await prisma.conversationMessage.findMany({ where: { conversationId: fx.conversationId }, orderBy: { createdAt: "asc" } });
		const request = llm.requests[0]!;
		llm.restore();
		const events = await prisma.proactiveEvent.findMany({ where: { botId: fx.botId }, orderBy: { createdAt: "asc" } });
		return { snap, request, effects: { status: snap.run.status, stopReason: snap.run.stopReason ?? null, posted: assistantTexts(conversation), events: events.map((event) => `${event.kind}:${event.detail ?? ""}`) } };
	}

	test("lembrete sem novidade ([NO_UPDATE]): nada entra na conversa, igual ao v1", async () => {
		const v1 = await proactiveRun("v1", "followup", [{ content: "[NO_UPDATE]" }]);
		const v2 = await proactiveRun("v2", "followup", [{ content: "[NO_UPDATE]" }]);
		assert.equal(v2.snap.run.origin, "proactive");
		assert.equal(v2.snap.budget.engine, "v2", "o lembrete rodou no v2");
		assert.equal(v2.snap.budget.engineProfile, "chat");
		assert.ok(v2.request.toolNames.includes("schedule_followup"));
		assert.ok(!v2.request.toolNames.includes("notify_user"), "no lembrete quem fala é o texto final, não o notify_user");
		assert.deepEqual(v2.effects, v1.effects);
		assert.deepEqual(v2.effects.posted, []);
	});

	test("lembrete com novidade: a mensagem curta entra na conversa, igual ao v1", async () => {
		const v1 = await proactiveRun("v1", "followup", [{ content: "O pedido do cliente X chegou hoje." }]);
		const v2 = await proactiveRun("v2", "followup", [{ content: "O pedido do cliente X chegou hoje." }]);
		assert.equal(v2.snap.budget.engine, "v2");
		assert.deepEqual(v2.effects, v1.effects);
		assert.deepEqual(v2.effects.posted, ["O pedido do cliente X chegou hoje."]);
	});

	test("reflexão sem conversa: recebe as tools da reflexão (inclui notify_user) e termina em silêncio quando não há o que dizer", async () => {
		const v1 = await proactiveRun("v1", "reflection", [{ content: "DONE" }]);
		const v2 = await proactiveRun("v2", "reflection", [{ content: "DONE" }]);
		assert.equal(v2.snap.budget.engine, "v2");
		assert.equal(v2.snap.run.conversationId, null);
		for (const name of ["schedule_followup", "list_followups", "suggest_routine", "notify_user"]) assert.ok(v2.request.toolNames.includes(name), name);
		assert.ok(!v2.request.toolNames.includes("cancel_followup"));
		assert.deepEqual(v2.effects, v1.effects);
	});

	test("reflexão com novidade: notify_user grava a mensagem na conversa do bot e conta no teto, igual ao v1", async () => {
		const script: ScriptEntry[] = [{ tools: [{ name: "notify_user", args: { message: "A entrega vence amanhã." } }] }, { content: "DONE" }];
		const v1 = await proactiveRun("v1", "reflection", script);
		const v2 = await proactiveRun("v2", "reflection", script);
		assert.equal(v2.snap.budget.engine, "v2");
		assert.deepEqual(v2.effects, v1.effects);
		assert.deepEqual(v2.effects.posted, ["A entrega vence amanhã."]);
		assert.ok(v2.effects.events.some((event) => event.startsWith("message")), JSON.stringify(v2.effects.events));
	});

	test("sem o escopo all (v2/chat ou v1 explícito) a reflexão e o lembrete continuam no v1; bot sem escolha roda no v2 (padrão)", async () => {
		for (const policy of [{ engine: "v1" }, { engine: "v2" }, { engine: "v2", engineScope: "chat" }, {}]) {
			const fx = await createFixture({ isPrimary: true, policy: { ...policy, ...proactiveOn } });
			llm = installFakeLlm([{ content: "[NO_UPDATE]" }]);
			const { createAgentRun } = await import("@workspace/db");
			const objective = "check";
			const run = await createAgentRun({ userId: fx.userId, model: "test/model", request: { botId: fx.botId, conversationId: fx.conversationId, origin: "proactive", objective, messages: [{ role: "user", content: objective }], silent: true } as never });
			await processRun(run.id);
			assert.equal((await snapshot(run.id)).budget.engine, Object.keys(policy).length === 0 ? "v2" : undefined, JSON.stringify(policy));
			llm.restore();
		}
	});
});

describe("evento de configuração do bot no v2", { skip: integrationSkip }, () => {
	async function configEvent(which: Which) {
		const fx = await createFixture({ policy: { engine: which } });
		llm = installFakeLlm([{ content: "Oi! Sou o seu novo assistente." }]);
		const { app } = await createApi(fx.userId);
		const sent = await sendChat(app, fx, '[bot-created] Bot "Cookie" recém-criado: faça o onboarding.');
		assert.equal(sent.status, 202, JSON.stringify(sent.json));
		await processRun(sent.runId);
		const snap = await snapshot(sent.runId);
		const request = llm.requests[0]!;
		const system = JSON.stringify(request.messages.filter((m) => m.role === "system"));
		llm.restore();
		return { snap, request, system, effects: { status: snap.run.status, posted: assistantTexts(snap.messages) } };
	}

	test("sem mensagem digitada: roda no v2 (escopo chat), com a instrução do evento e as tools do onboarding, igual ao v1", async () => {
		const v1 = await configEvent("v1");
		const v2 = await configEvent("v2");
		assert.equal(v1.snap.budget.engine, undefined);
		assert.equal(v2.snap.budget.engine, "v2");
		assert.match(v2.system, /BOT EVENT \(bot created/);
		assert.ok(v2.request.toolNames.includes("propose_questionnaire"));
		assert.deepEqual(v2.effects, v1.effects);
		assert.deepEqual(v2.effects.posted, ["Oi! Sou o seu novo assistente."]);
	});
});
