import assert from "node:assert/strict";
import { test } from "node:test";
import { SILENT_RETURN_MARK, isSilentReturnObjective, processOwnerWaitJob, type OwnerWaitProcessorDeps } from "./owner-wait.js";

type Created = Parameters<OwnerWaitProcessorDeps["createAgentRun"]>[0];

function fakeDeps(over: Partial<OwnerWaitProcessorDeps> = {}) {
	const created: Created[] = [];
	const enqueued: string[] = [];
	const calls: string[] = [];
	const source = { id: "run1", userId: "user-a", botId: "bot-a", conversationId: "conv-1", origin: "chat", model: "m", status: "completed", budgetJson: { engine: "v3", humanTurn: true } };
	const deps = {
		getAgentRun: async (id: string) => (id === "run1" ? source : null),
		getSkillPendingIntent: async () => ({ id: "p1", kind: "confirm", payload: { kind: "confirm", action: "tool-call", confirmId: "confirm-toolab12cd34-run1", toolCall: { callKey: "k1", tool: "page_share", label: "Criar um link público do painel", refused: ["call:old"] } } }),
		claimSkillPendingIntent: async () => { calls.push("claim"); return true; },
		closePendingConfirmCard: async (input: { status: string; detail: string }) => { calls.push(`close:${input.status}:${input.detail}`); return { confirmId: "confirm-toolab12cd34-run1", title: "Criar um link público do painel?", callKey: "k1" }; },
		dismissPendingQuestionnaireCard: async () => { calls.push("dismiss"); return { questionnaireId: "questionnaire-run1", title: "Formato?" }; },
		markPendingLoginOutcome: async (input: { outcome: string }) => { calls.push(`login:${input.outcome}`); return "login-1"; },
		requestResumeAgentRun: async () => { calls.push("resume"); return source; },
		createAgentRun: async (input: Created) => { created.push(input); return { ...source, id: `new${created.length}`, status: "queued" }; },
		claimDueReturn: async () => ({ id: "ret1", userId: "user-a", botId: "bot-a", conversationId: "conv-1", sourceRunId: "run1", dueAt: new Date(), reason: "ver o deploy", visible: true, status: "fired", runId: null, createdAt: new Date("2026-11-04T12:00:00Z") }),
		markReturnRun: async () => undefined,
		releaseReturnClaim: async () => { calls.push("release"); return true; },
		closeReturnCard: async (input: { returnId: string; status: string }) => { calls.push(`marker:${input.returnId}:${input.status}`); return true; },
		enqueueRun: async (runId: string) => { enqueued.push(runId); return true; },
		...over,
	} as unknown as OwnerWaitProcessorDeps;
	return { deps, created, enqueued, calls };
}

const timeout = { kind: "card_timeout" as const, userId: "user-a", conversationId: "conv-1", runId: "run1", card: "tool-call" as const, cardId: "confirm-toolab12cd34-run1", toolName: "page_share", what: "Criar um link público do painel", minutes: 30 };

test("prazo vencido na aprovação: cartão fecha como tempo esgotado (nunca aprova) e o run continua sem aquilo", async () => {
	const { deps, created, enqueued, calls } = fakeDeps();
	const result = await processOwnerWaitJob(timeout, deps);
	assert.equal(result.outcome, "resumed");
	assert.deepEqual(calls, ["claim", "close:rejected:Tempo esgotado · segui sem isso"]);
	const seed = created[0]!.request.transcriptSeed!;
	assert.equal(seed.fromRunId, "run1");
	assert.equal(seed.toolName, "page_share");
	assert.match(seed.resultContent, /within 30 min/);
	assert.match(seed.resultContent, /NOT approved/);
	assert.match(seed.resultContent, /Continue the rest of the task without it/);
	assert.deepEqual(seed.refused, ["call:old", "call:k1"]);
	assert.equal(created[0]!.request.silent, true);
	assert.equal(created[0]!.inheritFromRunId, "run1");
	assert.deepEqual(enqueued, ["new1"]);
});

test("dono respondeu antes do prazo: nada acontece (sem run, sem cartão)", async () => {
	const { deps, created, calls } = fakeDeps({ closePendingConfirmCard: (async () => null) as unknown as OwnerWaitProcessorDeps["closePendingConfirmCard"] });
	const result = await processOwnerWaitJob(timeout, deps);
	assert.equal(result.outcome, "noop");
	assert.equal(created.length, 0);
	assert.equal(calls.filter((call) => call === "claim").length, 1);
});

test("prazo do questionário: dispensa o cartão e a pergunta não volta", async () => {
	const { deps, created } = fakeDeps();
	await processOwnerWaitJob({ ...timeout, card: "questionnaire", cardId: "questionnaire-run1", toolName: "propose_questionnaire", what: "Formato?" }, deps);
	assert.equal(created[0]!.request.transcriptSeed?.toolName, "propose_questionnaire");
	assert.deepEqual(created[0]!.request.transcriptSeed?.refused, ["tool:propose_questionnaire"]);
});

test("prazo do login/VM: o run pausado retoma ele mesmo como pulado; já respondido = nada", async () => {
	const { deps, enqueued, calls, created } = fakeDeps();
	const result = await processOwnerWaitJob({ ...timeout, card: "login", cardId: "login-1" }, deps);
	assert.deepEqual(calls, ["login:skipped_timeout", "resume"]);
	assert.deepEqual(enqueued, ["run1"]);
	assert.equal(created.length, 0);
	assert.equal(result.runId, "run1");
	const answered = fakeDeps({ markPendingLoginOutcome: (async () => null) as unknown as OwnerWaitProcessorDeps["markPendingLoginOutcome"] });
	assert.equal((await processOwnerWaitJob({ ...timeout, card: "login", cardId: "login-1" }, answered.deps)).outcome, "noop");
	assert.equal(answered.enqueued.length, 0);
});

test("retorno agendado acorda a mesma conversa com contexto, herdando do run que agendou", async () => {
	const { deps, created, enqueued, calls } = fakeDeps();
	const result = await processOwnerWaitJob({ kind: "scheduled_return", userId: "user-a", returnId: "ret1" }, deps);
	assert.equal(result.outcome, "resumed");
	assert.equal(created[0]!.request.conversationId, "conv-1");
	assert.equal(created[0]!.request.origin, "chat");
	assert.equal(created[0]!.inheritFromRunId, "run1");
	assert.equal(created[0]!.inheritHumanTurn, false, "ninguém presente: sem turno humano, só leitura");
	assert.match(created[0]!.request.messages[0]!.content, /\[Scheduled return\].*ver o deploy.*post the result/);
	assert.deepEqual(enqueued, ["new1"]);
	assert.deepEqual(calls, ["marker:ret1:done"], "o marcador \"Volto às\" do dono fecha quando o retorno chega");
});

test("retorno silencioso só posta com novidade ([NO_UPDATE]) e é reconhecido pelo worker", async () => {
	const { deps, created, calls } = fakeDeps({ claimDueReturn: (async () => ({ id: "ret1", userId: "user-a", botId: "bot-a", conversationId: "conv-1", sourceRunId: "run1", dueAt: new Date(), reason: "ver o pedido", visible: false, status: "fired", runId: null, createdAt: new Date() })) as unknown as OwnerWaitProcessorDeps["claimDueReturn"] });
	await processOwnerWaitJob({ kind: "scheduled_return", userId: "user-a", returnId: "ret1" }, deps);
	const content = created[0]!.request.messages[0]!.content;
	assert.ok(content.startsWith(SILENT_RETURN_MARK));
	assert.equal(created[0]!.inheritHumanTurn, false);
	assert.match(content, /reply exactly \[NO_UPDATE\]/);
	assert.equal(isSilentReturnObjective(content), true);
	assert.equal(isSilentReturnObjective("[Scheduled return] visível"), false);
	assert.ok(!calls.includes("marker:ret1:done"), "silencioso não tem marcador");
});

test("retorno cancelado (ou de outro dono) não cria run", async () => {
	const { deps, created } = fakeDeps({ claimDueReturn: (async () => null) as unknown as OwnerWaitProcessorDeps["claimDueReturn"] });
	assert.equal((await processOwnerWaitJob({ kind: "scheduled_return", userId: "user-b", returnId: "ret1" }, deps)).outcome, "noop");
	assert.equal(created.length, 0);
});

test("retorno agendado por run sem humano (rotina) vira run proativo: só leitura e silêncio", async () => {
	const { deps, created } = fakeDeps({ getAgentRun: (async () => ({ id: "run1", userId: "user-a", botId: "bot-a", conversationId: "conv-1", origin: "routine", model: "m" })) as unknown as OwnerWaitProcessorDeps["getAgentRun"] });
	await processOwnerWaitJob({ kind: "scheduled_return", userId: "user-a", returnId: "ret1" }, deps);
	assert.equal(created[0]!.request.origin, "proactive");
});

test("corrida com o clique: o dono reservou a intenção primeiro, o prazo não fecha o cartão nem cria run", async () => {
	const { deps, created, calls } = fakeDeps({ claimSkillPendingIntent: (async () => false) as unknown as OwnerWaitProcessorDeps["claimSkillPendingIntent"] });
	const result = await processOwnerWaitJob(timeout, deps);
	assert.equal(result.outcome, "noop");
	assert.equal(calls.some((call) => call.startsWith("close:")), false, "o prazo não pode trocar o desfecho do cartão");
	assert.equal(created.length, 0, "um cartão, um efeito");
});

test("retorno: criar o run falhou depois da reserva = devolve a pendente e o job falha (nova tentativa dispara)", async () => {
	const { deps, calls } = fakeDeps({ createAgentRun: (async () => { throw new Error("db fora"); }) as unknown as OwnerWaitProcessorDeps["createAgentRun"] });
	await assert.rejects(processOwnerWaitJob({ kind: "scheduled_return", userId: "user-a", returnId: "ret1" }, deps), /db fora/);
	assert.deepEqual(calls, ["release"]);
});
