import assert from "node:assert/strict";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

type AuthEnv = import("../middleware/auth.js").AuthEnv;

async function appFor(userId: string) {
	const { Hono } = await import("hono");
	const { createRoutineRoutes } = await import("./routines.js");
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createRoutineRoutes(null));
	return app;
}

function briefRow(userId: string) {
	return {
		id: "routine-b", userId, botId: "bot-b", conversationId: null, groupId: null, pageId: "page-b", template: "daily_brief",
		name: "Seu dia", prompt: "foco", model: "", allowChatgptPlan: false, enabled: true, triggerType: "cron", schedule: "30 7 * * 1-5",
		timezone: "America/Sao_Paulo", triggerJson: null, notify: "always", createdBy: "bot", lastRunAt: null, createdAt: new Date(0), updatedAt: new Date(0),
	};
}

async function patch(body: Record<string, unknown>) {
	const { prisma } = await import("@workspace/db");
	const find = prisma.routine.findFirst;
	const update = prisma.routine.update;
	const runFind = prisma.routineRun.findFirst;
	let data: Record<string, unknown> | undefined;
	Reflect.set(prisma.routine, "findFirst", async () => briefRow("b"));
	Reflect.set(prisma.routineRun, "findFirst", async () => null);
	Reflect.set(prisma.routine, "update", async (args: { data: Record<string, unknown> }) => {
		data = args.data;
		return { ...briefRow("b"), ...args.data };
	});
	try {
		const app = await appFor("b");
		const res = await app.request("/v1/bots/bot-b/routines/routine-b", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: res.status, data, error: ((await res.clone().json()) as { error?: string }).error };
	} finally {
		prisma.routine.findFirst = find;
		prisma.routine.update = update;
		prisma.routineRun.findFirst = runFind;
	}
}

test("PATCH do 'Seu dia': trocar para intervalo ou vários horários por dia é recusado e nada é gravado", async () => {
	const interval = await patch({ triggerType: "interval", intervalTrigger: { everyMinutes: 30 } });
	assert.equal(interval.status, 400);
	assert.match(interval.error ?? "", /uma vez por dia/);
	assert.equal(interval.data, undefined);
	const multi = await patch({ triggerType: "cron", schedule: "*/5 * * * *" });
	assert.equal(multi.status, 400);
	assert.match(multi.error ?? "", /once a day/i);
	assert.equal(multi.data, undefined);
});

test("PATCH do 'Seu dia': horário de uma vez por dia passa e notify 'important' vira 'always'", async () => {
	const ok = await patch({ triggerType: "cron", schedule: "0 6 * * 1-5", notify: "important" });
	assert.equal(ok.status, 200);
	assert.equal(ok.data?.schedule, "0 6 * * 1-5");
	assert.equal(ok.data?.notify, "always");
});

test("o create da API não aceita 'template' vindo do cliente", async () => {
	const { parseCreateBody } = await import("./routines.js");
	const parsed = parseCreateBody("bot", { name: "T", prompt: "P", enabled: false, triggerType: "cron", schedule: null, template: "daily_brief" });
	assert.ok(!("error" in parsed));
	assert.equal((parsed as { template?: unknown }).template, undefined);
});
