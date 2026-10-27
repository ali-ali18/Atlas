import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "@workspace/db";
import { buildUserTurn, processExecuteRoutineJob } from "./routine.js";

/**
 * Brief "Seu dia": nunca pulado nem adiado por causa de um chat em andamento (roda sem conversa), com as
 * instruções e o catálogo de fontes SÓ do dono. O mesmo cenário numa rotina comum adia.
 */

const config = { redisUrl: "fixture", openRouterApiKey: "fixture", openRouterModel: "fixture/model", summarizerModel: "fixture/model", agentRunConcurrency: 1 };
const now = new Date("2026-10-26T10:30:00Z");

type Patched = Array<[object, string, unknown]>;
function patch(list: Patched, target: object, key: string, value: unknown) {
	list.push([target, key, Reflect.get(target, key)]);
	Reflect.set(target, key, value);
}

function scenario(input: { template: string | null; chatBusy: boolean; pageId?: string | null }) {
	const patched: Patched = [];
	const seen = { agentRunData: [] as Array<Record<string, unknown>>, activeRunQueries: 0, routineRunCreates: [] as Array<Record<string, unknown>>, mcpWhere: [] as unknown[], apiWhere: [] as unknown[], enqueued: [] as string[], attached: [] as Array<Record<string, unknown>> };
	patch(patched, prisma.routine, "findUnique", async () => ({
		id: "r", userId: "user-a", botId: "bot-a", pageId: input.pageId === undefined ? "page-1" : input.pageId, template: input.template, name: "Seu dia", prompt: "Do not look at Slack.", enabled: true,
		triggerType: "cron", triggerJson: null, model: "openrouter/x", allowChatgptPlan: false,
	}));
	patch(patched, prisma.bot, "findFirst", async ({ where }: { where: { id?: unknown } }) =>
		// "outro bot na mesma conversa" (checagem de grupo/dono do createAgentRun): não há.
		typeof where.id === "object" && where.id !== null ? null : { id: "bot-a", conversationId: "conv-a", openRouterModel: "openrouter/x", policyJson: null });
	patch(patched, prisma.page, "findFirst", async ({ where }: { where: { id?: string } }) => ({ id: where.id ?? "page-1", botId: "bot-a", conversationId: null, groupId: null, title: "Seu dia", specJson: { v: 2, title: "Seu dia", summary: "x", root: { type: "stack", children: [{ type: "callout", props: { title: "t", text: "x", tone: "info" } }] } }, sourcesJson: [], revision: 1, refreshedAt: null, createdAt: now, updatedAt: now }));
	patch(patched, prisma.conversation, "findFirst", async () => ({ id: "conv-a", userId: "user-a" }));
	patch(patched, prisma.bot, "updateMany", async () => ({ count: 0 }));
	patch(patched, prisma.routineRun, "findFirst", async () => null);
	patch(patched, prisma.routineRun, "updateMany", async () => ({ count: 0 }));
	patch(patched, prisma.routineRun, "create", async ({ data }: { data: Record<string, unknown> }) => {
		seen.routineRunCreates.push(data);
		return { id: "rr", routineId: "r", triggeredBy: "schedule", status: data.status, error: data.error ?? null, createdAt: now, scheduledFor: null, startedAt: null, finishedAt: null, summary: null, agentRunId: null, eventJson: null };
	});
	patch(patched, prisma.routineRun, "update", async ({ data }: { data: Record<string, unknown> }) => {
		seen.attached.push(data);
		return { id: "rr", routineId: "r", triggeredBy: "schedule", status: data.status ?? "running", error: null, createdAt: now, scheduledFor: null, startedAt: now, finishedAt: null, summary: null, agentRunId: data.agentRunId ?? null, eventJson: null };
	});
	patch(patched, prisma.routine, "update", async () => ({}));
	patch(patched, prisma, "$transaction", async (ops: Promise<unknown>[]) => Promise.all(ops));
	patch(patched, prisma.agentRun, "findMany", async () => {
		seen.activeRunQueries += 1;
		return input.chatBusy ? [{ id: "chat-run", userId: "user-a", botId: "bot-a", conversationId: "conv-a", origin: "chat", objective: "x", status: "running", model: "m", maxSteps: 10, sandboxSessionId: null, error: null, resultText: null, cancelRequested: false, createdAt: now, updatedAt: now, startedAt: now, finishedAt: null }] : [];
	});
	patch(patched, prisma.agentRun, "create", async ({ data }: { data: Record<string, unknown> }) => {
		seen.agentRunData.push(data);
		return { id: "agent-run-1", ...data, createdAt: now, updatedAt: now };
	});
	patch(patched, prisma.agentRun, "update", async () => ({}));
	patch(patched, prisma.mcpConnection, "findMany", async ({ where }: { where: unknown }) => {
		seen.mcpWhere.push(where);
		return [];
	});
	patch(patched, prisma.apiConnection, "findMany", async ({ where }: { where: unknown }) => {
		seen.apiWhere.push(where);
		return [];
	});
	const queue = { getJob: async () => null, add: async (_name: string, data: { runId: string }) => void seen.enqueued.push(data.runId) } as unknown as Parameters<typeof processExecuteRoutineJob>[2];
	const deferred: unknown[] = [];
	const restore = () => {
		for (const [target, key, original] of patched.reverse()) Reflect.set(target, key, original);
	};
	return { seen, queue, deferred, restore, deferJob: async (payload: unknown) => void deferred.push(payload) };
}

test("brief com chat em andamento: roda sem conversa, não consulta o chat, não adia nem pula", async () => {
	const s = scenario({ template: "daily_brief", chatBusy: true });
	try {
		const result = await processExecuteRoutineJob({ routineId: "r", triggeredBy: "schedule" }, config, s.queue, { deferJob: s.deferJob });
		assert.equal(result.status, "running");
		assert.equal(result.agentRunId, "agent-run-1");
		assert.equal(s.seen.activeRunQueries, 0, "não olha se há run ativo na conversa");
		assert.equal(s.deferred.length, 0);
		// run sem conversa (não disputa o índice único) e ainda de rotina (painel, aviso e push do fim usam isso)
		assert.equal(s.seen.agentRunData[0]?.conversationId, null);
		assert.equal(s.seen.agentRunData[0]?.origin, "routine");
		assert.equal(s.seen.agentRunData[0]?.userId, "user-a");
		assert.deepEqual(s.seen.enqueued, ["agent-run-1"]);
		// as instruções do brief entram só neste run
		const objective = String(s.seen.agentRunData[0]?.objective);
		assert.match(objective, /\[DAILY BRIEF\]/);
		assert.match(objective, /\[SOURCES\]/);
		assert.doesNotMatch(objective, /PAGE TARGET/, "o brief não tem painel, mesmo que a rotina tenha um pageId herdado");
		assert.match(objective, /User focus \(may exclude sources or add what to watch\): Do not look at Slack\./);
		// fontes só do dono da rotina (a consulta do db filtra por userId)
		assert.deepEqual(s.seen.mcpWhere[0] && (s.seen.mcpWhere[0] as { userId: unknown }).userId, { in: ["user-a"] });
		assert.deepEqual(s.seen.apiWhere[0] && (s.seen.apiWhere[0] as { userId: unknown }).userId, { in: ["user-a"] });
	} finally {
		s.restore();
	}
});

test("controle: a MESMA situação numa rotina comum adia por causa do chat (o brief é a exceção)", async () => {
	const s = scenario({ template: null, chatBusy: true });
	try {
		const result = await processExecuteRoutineJob({ routineId: "r", triggeredBy: "schedule" }, config, s.queue, { deferJob: s.deferJob });
		assert.equal(result.status, "queued");
		assert.equal(s.deferred.length, 1);
		assert.equal(s.seen.activeRunQueries, 1);
		assert.equal(s.seen.agentRunData.length, 0);
	} finally {
		s.restore();
	}
});

test("brief com chat livre também roda sem conversa; rotina comum roda na conversa e sem o bloco do brief", async () => {
	const brief = scenario({ template: "daily_brief", chatBusy: false });
	try {
		await processExecuteRoutineJob({ routineId: "r", triggeredBy: "manual" }, config, brief.queue);
		assert.equal(brief.seen.agentRunData[0]?.conversationId, null);
	} finally {
		brief.restore();
	}
	const plain = scenario({ template: null, chatBusy: false });
	try {
		await processExecuteRoutineJob({ routineId: "r", triggeredBy: "manual" }, config, plain.queue);
		assert.equal(plain.seen.agentRunData[0]?.conversationId, "conv-a");
		assert.doesNotMatch(String(plain.seen.agentRunData[0]?.objective), /DAILY BRIEF|\[SOURCES\]/);
		assert.equal(plain.seen.mcpWhere.length, 0, "rotina comum nem lista as fontes");
	} finally {
		plain.restore();
	}
});

test("buildUserTurn: brief traz instruções e fontes antes da tarefa; sem brief nada muda", () => {
	const turn = buildUserTurn("Do not look at Slack.", "Seu dia", { routineId: "r", triggeredBy: "schedule" }, null, null, { instructions: "[DAILY BRIEF] x", sourcesBlock: "[SOURCES] y\n[/SOURCES]" });
	assert.ok(turn.indexOf("[DAILY BRIEF]") < turn.indexOf("Tarefa:"));
	assert.match(turn, /Tarefa:\nWrite the daily brief as instructed in \[DAILY BRIEF\]/);
	const plain = buildUserTurn("Revise.", "n", { routineId: "r", triggeredBy: "schedule" }, null);
	assert.doesNotMatch(plain, /DAILY BRIEF|SOURCES/);
	assert.match(plain, /Tarefa:\nRevise\./);
});

test("brief sem painel roda (não recria painel); rotina comum com painel apagado segue pulando", async () => {
	const s = scenario({ template: "daily_brief", chatBusy: false, pageId: null });
	try {
		const result = await processExecuteRoutineJob({ routineId: "r", triggeredBy: "schedule" }, config, s.queue);
		assert.equal(result.status, "running");
		assert.doesNotMatch(String(s.seen.agentRunData[0]?.objective), /PAGE TARGET/);
	} finally {
		s.restore();
	}
});
