import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "@workspace/db";
import { processExecuteRoutineJob } from "./routine.js";
test("rotina de B não acessa bot de A; sem opt-in e fallback não enfileira", async () => {
	const routineFind = prisma.routine.findUnique,
		botFind = prisma.bot.findFirst,
		runFind = prisma.routineRun.findFirst,
		runCreate = prisma.routineRun.create,
		runUpdate = prisma.routineRun.update;
	let owner = "b",
		updates: Array<Record<string, unknown>> = [];
	Reflect.set(prisma.routine, "findUnique", async () => ({
		id: "r",
		userId: owner,
		botId: "bot-a",
		name: "Task",
		prompt: "Read",
		enabled: true,
		triggerJson: null,
		model: "chatgpt/luna",
		allowChatgptPlan: false,
	}));
	Reflect.set(
		prisma.bot,
		"findFirst",
		async ({ where }: { where: Record<string, unknown> }) => {
			assert.equal(where.ownerId, owner);
			return owner === "a"
				? {
						id: "bot-a",
						conversationId: null,
						policyJson: { chatgptFallbackModel: null },
					}
				: null;
		}
	);
	Reflect.set(prisma.routineRun, "findFirst", async () => null);
	Reflect.set(prisma.routineRun, "create", async () => ({
		id: "rr",
		createdAt: new Date(0),
	}));
	Reflect.set(
		prisma.routineRun,
		"update",
		async ({ data }: { data: Record<string, unknown> }) => {
			updates.push(data);
			return { id: "rr", createdAt: new Date(0) };
		}
	);
	const queue = {} as Parameters<typeof processExecuteRoutineJob>[2];
 Reflect.set(queue,"add",async()=>{throw new Error("Must not enqueue");});
	try {
		assert.equal(
			(
				await processExecuteRoutineJob(
					{ routineId: "r", triggeredBy: "manual" },
					{
						redisUrl: "fixture",
						openRouterApiKey: "fixture",
						openRouterModel: "fixture/model",
						summarizerModel: "fixture/model",
						agentRunConcurrency: 1,
					},
					queue
				)
			).status,
			"skipped"
		);
		owner = "a";
		assert.equal(
			(
				await processExecuteRoutineJob(
					{ routineId: "r", triggeredBy: "manual" },
					{
						redisUrl: "fixture",
						openRouterApiKey: "fixture",
						openRouterModel: "fixture/model",
						summarizerModel: "fixture/model",
						agentRunConcurrency: 1,
					},
					queue
				)
			).status,
			"skipped"
		);
		assert.match(String(updates[0]?.error), /opt-in/);
	} finally {
		prisma.routine.findUnique = routineFind;
		prisma.bot.findFirst = botFind;
		prisma.routineRun.findFirst = runFind;
		prisma.routineRun.create = runCreate;
		prisma.routineRun.update = runUpdate;
	}
});

test("rotina com painel apagado (ou de outro dono) pula com 'Painel apagado' e nada é enfileirado", async () => {
	const routineFind = prisma.routine.findUnique,
		botFind = prisma.bot.findFirst,
		pageFind = prisma.page.findFirst,
		runFind = prisma.routineRun.findFirst,
		runCreate = prisma.routineRun.create;
	const created: Array<Record<string, unknown>> = [];
	let pageWhere: Record<string, unknown> | undefined;
	Reflect.set(prisma.routine, "findUnique", async () => ({
		id: "r", userId: "user-a", botId: "bot-a", pageId: "page-1", name: "Painel", prompt: "Rebuild", enabled: true, triggerJson: null, model: "openrouter/x", allowChatgptPlan: false,
	}));
	Reflect.set(prisma.bot, "findFirst", async () => ({ id: "bot-a", conversationId: null, openRouterModel: "m", policyJson: null }));
	Reflect.set(prisma.page, "findFirst", async ({ where }: { where: Record<string, unknown> }) => {
		pageWhere = where;
		return null;
	});
	Reflect.set(prisma.routineRun, "findFirst", async () => null);
	Reflect.set(prisma.routineRun, "create", async ({ data }: { data: Record<string, unknown> }) => {
		created.push(data);
		return { id: "rr", routineId: "r", triggeredBy: "schedule", status: data.status, error: data.error ?? null, createdAt: new Date(0), scheduledFor: null, startedAt: null, finishedAt: null, summary: null, agentRunId: null, eventJson: null };
	});
	const queue = {} as Parameters<typeof processExecuteRoutineJob>[2];
	Reflect.set(queue, "add", async () => {
		throw new Error("Must not enqueue");
	});
	try {
		const result = await processExecuteRoutineJob(
			{ routineId: "r", triggeredBy: "schedule" },
			{ redisUrl: "fixture", openRouterApiKey: "fixture", openRouterModel: "fixture/model", summarizerModel: "fixture/model", agentRunConcurrency: 1 },
			queue,
		);
		assert.equal(result.status, "skipped");
		assert.equal(created[0]?.status, "skipped");
		assert.equal(created[0]?.error, "Painel apagado");
		// O painel é buscado escopado pelo dono da rotina e ignorando os apagados.
		assert.equal(pageWhere?.userId, "user-a");
		assert.equal(pageWhere?.id, "page-1");
		assert.equal(pageWhere?.deletedAt, null);
	} finally {
		prisma.routine.findUnique = routineFind;
		prisma.bot.findFirst = botFind;
		prisma.page.findFirst = pageFind;
		prisma.routineRun.findFirst = runFind;
		prisma.routineRun.create = runCreate;
	}
});
