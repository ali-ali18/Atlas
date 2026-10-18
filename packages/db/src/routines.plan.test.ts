import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "./client.js";
import { createRoutine, updateRoutine } from "./routines.js";
test("opt-in de plano exige dono na criação e alteração", async () => {
	const botFind = prisma.bot.findFirst,
		create = prisma.routine.create,
		find = prisma.routine.findFirst,
		update = prisma.routine.update,
		runFind = prisma.routineRun.findFirst;
	let writes = 0;
	const row = {
		id: "r",
		botId: "bot-a",
		userId: "a",
		name: "Task",
		prompt: "Read",
		enabled: false,
		triggerType: "interval",
		schedule: null,
		triggerJson: { kind: "interval", everyMinutes: 30 },
		conversationId: null,
		model: null,
		timezone: "UTC",
		lastRunAt: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		allowChatgptPlan: false,
	};
	Reflect.set(
		prisma.bot,
		"findFirst",
		async ({ where }: { where: Record<string, unknown> }) =>
			where.ownerId === "a"
				? { id: "bot-a", conversationId: null, openRouterModel: "chatgpt/luna" }
				: null
	);
	Reflect.set(
		prisma.routine,
		"create",
		async ({ data }: { data: Record<string, unknown> }) => {
			writes++;
			return { ...row, ...data };
		}
	);
	Reflect.set(
		prisma.routine,
		"findFirst",
		async ({ where }: { where: Record<string, unknown> }) =>
			where.userId === "a" ? row : null
	);
	Reflect.set(prisma.routineRun, "findFirst", async () => null);
	Reflect.set(
		prisma.routine,
		"update",
		async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			assert.equal(where.userId, "a");
			writes++;
			return { ...row, ...data };
		}
	);
	const input = {
		botId: "bot-a",
		name: "Task",
		prompt: "Read",
		enabled: false,
		triggerType: "interval" as const,
		trigger: { kind: "interval" as const, everyMinutes: 30 },
	};
	try {
		assert.equal(
			(await createRoutine("a", input)).routine.allowChatgptPlan,
			false
		);
		assert.equal(
			(await createRoutine("a", { ...input, allowChatgptPlan: true })).routine
				.allowChatgptPlan,
			true
		);
		await assert.rejects(
			createRoutine("b", { ...input, allowChatgptPlan: true }),
			/Bot não encontrado/
		);
		assert.equal(
			await updateRoutine("b", "bot-a", "r", { allowChatgptPlan: true }),
			null
		);
		assert.equal(writes, 2);
		assert.equal(
			(await updateRoutine("a", "bot-a", "r", { allowChatgptPlan: true }))
				?.allowChatgptPlan,
			true
		);
		assert.equal(writes, 3);
	} finally {
		prisma.bot.findFirst = botFind;
		prisma.routine.create = create;
		prisma.routine.findFirst = find;
		prisma.routine.update = update;
		prisma.routineRun.findFirst = runFind;
	}
});
