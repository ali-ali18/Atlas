/**
 * Rotas do sono (F5.3). Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/sleep.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { SleepReportView } from "@workspace/shared";
import type { AuthEnv } from "../middleware/auth.js";
import { createSleepRoutes, type SleepRouteDeps } from "./sleep.js";

const report = (over: Partial<SleepReportView> = {}): SleepReportView => ({ id: "r1", botId: "b1", kind: "daily", slot: "2026-11-04", status: "done", summary: "Guardei 2 coisas.", proposals: [{ id: "skill:x", kind: "skill", status: "open", name: "N", description: "D", instructions: "I" }], stats: { facts: 2 }, createdAt: "2026-11-05T02:30:00.000Z", finishedAt: "2026-11-05T02:31:00.000Z", ...over });

function appWith(userId = "u1") {
	const mine = report();
	const calls: string[] = [];
	const deps: SleepRouteDeps = {
		botOwned: async (user, botId) => user === "u1" && botId === "b1",
		reports: async (input) => (calls.push(`reports:${input.userId}:${input.botId ?? "-"}:${input.kind ?? "-"}`), { reports: input.userId === "u1" ? [mine] : [], nextCursor: null }),
		report: async (user, id) => (user === "u1" && id === "r1" ? mine : null),
		dismiss: async (input) => {
			calls.push(`dismiss:${input.userId}:${input.reportId}:${input.proposalId}`);
			if (input.userId !== "u1" || input.reportId !== "r1" || input.proposalId !== "skill:x") return null;
			mine.proposals = mine.proposals.map((p) => ({ ...p, status: "dismissed" as const }));
			return mine;
		},
		changes: async (input) => (calls.push(`changes:${input.userId}:${input.botId ?? "-"}:${input.reportId ?? "-"}`), { changes: [], nextCursor: null }),
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createSleepRoutes(deps));
	return { app, calls, mine };
}

const post = { method: "POST" };

test("lista relatórios do dono com filtros; kind inválido é 400; bot alheio é 404", async () => {
	const { app, calls } = appWith();
	const res = await app.request("/v1/sleep/reports?botId=b1&kind=daily");
	assert.equal(res.status, 200);
	assert.equal(((await res.json()) as { reports: unknown[] }).reports.length, 1);
	assert.ok(calls.includes("reports:u1:b1:daily"));
	assert.equal((await app.request("/v1/sleep/reports?kind=outro")).status, 400);
	assert.equal((await app.request("/v1/sleep/reports?botId=b-alheio")).status, 404);
});

test("lê um relatório e dispensa uma proposta; proposta inexistente é 404", async () => {
	const { app } = appWith();
	assert.equal((await app.request("/v1/sleep/reports/r1")).status, 200);
	const dismissed = await app.request("/v1/sleep/reports/r1/proposals/skill:x/dismiss", post);
	assert.equal(dismissed.status, 200);
	assert.equal(((await dismissed.json()) as { report: SleepReportView }).report.proposals[0]?.status, "dismissed");
	assert.equal((await app.request("/v1/sleep/reports/r1/proposals/nao-existe/dismiss", post)).status, 404);
});

test("mudanças do sono: filtro por bot e por relatório", async () => {
	const { app, calls } = appWith();
	assert.equal((await app.request("/v1/sleep/changes?botId=b1&reportId=r1")).status, 200);
	assert.ok(calls.includes("changes:u1:b1:r1"));
	assert.equal((await app.request("/v1/sleep/changes?botId=b-alheio")).status, 404);
});

test("IDOR: o usuário B não lê, lista nem dispensa nada do A (404 ou vazio) e nada muda", async () => {
	const { app, mine } = appWith("u2");
	assert.equal((await app.request("/v1/sleep/reports/r1")).status, 404);
	assert.deepEqual(((await (await app.request("/v1/sleep/reports")).json()) as { reports: unknown[] }).reports, []);
	assert.equal((await app.request("/v1/sleep/reports?botId=b1")).status, 404);
	assert.equal((await app.request("/v1/sleep/changes?botId=b1")).status, 404);
	assert.equal((await app.request("/v1/sleep/reports/r1/proposals/skill:x/dismiss", post)).status, 404);
	assert.equal(mine.proposals[0]?.status, "open");
});
