import assert from "node:assert/strict";
import { test } from "node:test";
import { signDevCallback } from "@workspace/sandbox";
import type { DevSessionEvent } from "@workspace/shared";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { createDevJobCallbackRoutes, CALLBACK_PATH } = await import("./dev-job-callback.js");
const { DEV_JOB_SWEEP_INTERVAL_MS } = await import("../dev-jobs.js");

const NOW = 1_700_000_000_000;
const JOB = "abcdef012345";
const SESSION = { id: "s1", userId: "u", status: "RUNNING", conversationId: "conv" };

function setup(opts: { activeRun?: boolean } = {}) {
	const state = { activeRun: opts.activeRun ?? false, open: true };
	const events: DevSessionEvent[] = [];
	const polls: string[] = [];
	const app = createDevJobCallbackRoutes({
		autoDrain: false,
		now: () => NOW,
		getSession: async (id) => (id === "s1" ? SESSION : null),
		provider: () => ({ endpoint: async (id: string) => (id === "s1" ? { baseUrl: "http://x", token: "tok-s1" } : null) }) as never,
		hasActiveRun: async () => state.activeRun,
		jobs: {
			listOpenJobs: async () => (state.open ? [{ jobId: JOB, callId: "call-1", cmd: "pnpm dev", startedAt: NOW - 60_000 }] : []),
			emit: async (_s, event) => {
				events.push(event);
				if (event.type === "shell_done") state.open = false;
			},
			provider: () => ({ endpoint: async () => ({ baseUrl: "http://x", token: "tok-s1" }) }) as never,
			makeClient: () =>
				({
					execPoll: async (id: string) => {
						polls.push(id);
						return { running: false, exitCode: 2, status: "exited", timedOut: false, stdout: "boom\n", stderr: "", durationMs: 1234 };
					},
				}) as never,
			now: () => NOW,
		},
	});
	return { app, state, events, polls };
}

function request(app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, opts: { sessionId?: string; token?: string; jobId?: string; tamper?: boolean } = {}) {
	const sessionId = opts.sessionId ?? "s1";
	const body = JSON.stringify({ sessionId, jobId: opts.jobId ?? JOB, status: "exited", exitCode: 2, durationMs: 1, endedAt: NOW });
	const ts = String(Math.floor(NOW / 1000));
	const signature = `sha256=${signDevCallback(opts.token ?? "tok-s1", sessionId, ts, body)}`;
	return app.request(CALLBACK_PATH, { method: "POST", headers: { "X-Atlas-Timestamp": ts, "X-Atlas-Signature": signature }, body: opts.tamper ? body.replace("exited", "killed") : body });
}

test("assinatura inválida, sessão errada ou corpo adulterado: 401 sem tocar no container", async () => {
	const { app, events, polls } = setup();
	assert.equal((await request(app, { token: "outro" })).status, 401);
	assert.equal((await request(app, { tamper: true })).status, 401);
	assert.equal((await request(app, { sessionId: "s2", token: "tok-s1" })).status, 401);
	assert.equal(polls.length, 0);
	assert.equal(events.length, 0);
});

test("callback válido: consulta o job e emite shell_done uma única vez (repetição é idempotente)", async () => {
	const { app, events, polls } = setup();
	assert.equal((await request(app)).status, 200);
	assert.equal((await request(app)).status, 200);
	assert.deepEqual(polls, [JOB]);
	const done = events.filter((e) => e.type === "shell_done");
	assert.equal(done.length, 1);
	assert.deepEqual({ exitCode: (done[0] as { exitCode: number }).exitCode, endedReason: (done[0] as { endedReason: string }).endedReason }, { exitCode: 2, endedReason: "exit" });
	assert.equal(events.filter((e) => e.type === "shell_output").length, 1); // saída não transmitida vem do fim do job
});

test("com run ativo o aviso é adiado e a sessão é reconciliada quando o run termina", async () => {
	const { app, state, events } = setup({ activeRun: true });
	assert.equal((await request(app)).status, 202);
	assert.equal(app.pendingCount(), 1);
	assert.equal(events.length, 0);
	assert.equal(await app.drainPending(), 0); // run ainda ativo
	assert.equal(events.length, 0);
	state.activeRun = false;
	assert.equal(await app.drainPending(), 1);
	assert.equal(events.filter((e) => e.type === "shell_done").length, 1);
	assert.equal(app.pendingCount(), 0);
	assert.equal(await app.drainPending(), 0);
});

test("limite por sessão: excedido devolve 429", async () => {
	const { app } = setup();
	let last = 200;
	for (let i = 0; i < 62; i += 1) last = (await request(app, { token: "outro" })).status;
	assert.equal(last, 429);
});

test("a varredura de segurança roda a cada 5 minutos", () => {
	assert.equal(DEV_JOB_SWEEP_INTERVAL_MS, 5 * 60_000);
});
