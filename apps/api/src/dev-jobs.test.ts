import assert from "node:assert/strict";
import { test } from "node:test";
import { DevSandboxError } from "@workspace/sandbox";
import type { DevSessionEvent } from "@workspace/shared";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { reconcileSessionJobs, watchDevJobsOnce } = await import("./dev-jobs.js");

const NOW = 1_000_000_000_000;
const session = { id: "ds1", status: "RUNNING", conversationId: "conv" };
const job = (id: string, ageMs: number): { jobId: string; callId: string; cmd: string; startedAt: number; streamed?: boolean } => ({ jobId: id, callId: `call-${id}`, cmd: "pnpm install", startedAt: NOW - ageMs });

function setup(snaps: Record<string, unknown>, jobs = [job("a", 60_000)]) {
	const events: DevSessionEvent[] = [];
	const killed: string[] = [];
	const deps = {
		listOpenJobs: async () => jobs,
		emit: async (_s: unknown, event: DevSessionEvent) => void events.push(event),
		provider: () => ({ endpoint: async () => ({ baseUrl: "http://x", token: "t" }) }) as never,
		makeClient: () =>
			({
				execPoll: async (id: string) => {
					const snap = snaps[id];
					if (snap instanceof Error) throw snap;
					return snap;
				},
				execKill: async (id: string) => void killed.push(id),
			}) as never,
		now: () => NOW,
	};
	return { deps, events, killed };
}

test("vigia: job que terminou sem ninguém acompanhar recebe shell_done com exit, duração e o fim da saída", async () => {
	const { deps, events } = setup({ a: { running: false, exitCode: 0, status: "exited", timedOut: false, stdout: "ok\n", stderr: "", durationMs: 61_000 } });
	const result = await reconcileSessionJobs(session, deps);
	assert.equal(result.closed, 1);
	assert.equal(events[0]!.type, "shell_output");
	const done = events.at(-1) as Extract<DevSessionEvent, { type: "shell_done" }>;
	assert.deepEqual([done.type, done.jobId, done.callId, done.exitCode, done.durationMs, done.endedReason], ["shell_done", "a", "call-a", 0, 61_000, "exit"]);
});

test("vigia: job ainda rodando não emite nada; acima do teto de 30 min é morto e fecha com timeout", async () => {
	const running = { running: true, status: "running" };
	const fresh = setup({ a: running });
	assert.deepEqual(await reconcileSessionJobs(session, fresh.deps), { closed: 0, stillRunning: 1 });
	assert.equal(fresh.events.length, 0);

	const old = setup({ a: running }, [job("a", 32 * 60_000)]);
	await reconcileSessionJobs(session, old.deps);
	assert.deepEqual(old.killed, ["a"]);
	assert.equal((old.events[0] as { endedReason: string }).endedReason, "timeout");
});

test("vigia: container não conhece o job (404) vira lost; container inacessível tenta de novo depois", async () => {
	const lost = setup({ a: new DevSandboxError("não encontrado", 404) });
	await reconcileSessionJobs(session, lost.deps);
	assert.equal((lost.events[0] as { endedReason: string }).endedReason, "lost");

	const down = setup({ a: new DevSandboxError("inacessível", 503) });
	assert.deepEqual(await reconcileSessionJobs(session, down.deps), { closed: 0, stillRunning: 1 });
	assert.equal(down.events.length, 0);
});

test("sessão fora de RUNNING/IDLE: jobs abertos viram lost; force usa o motivo dado (reaper: stopped/timeout)", async () => {
	const stopped = setup({});
	await reconcileSessionJobs({ ...session, status: "STOPPED" }, stopped.deps);
	assert.equal((stopped.events[0] as { endedReason: string }).endedReason, "lost");

	const forced = setup({});
	await reconcileSessionJobs(session, forced.deps, { force: "timeout" });
	assert.equal((forced.events[0] as { endedReason: string; durationMs: number }).endedReason, "timeout");
	assert.equal((forced.events[0] as { durationMs: number }).durationMs, 60_000);
});

test("watchDevJobsOnce percorre as sessões ativas e completa os jobs", async () => {
	const { deps, events } = setup({ a: { running: false, exitCode: 1, status: "exited", timedOut: false, stdout: "", stderr: "boom", durationMs: 5 } });
	const total = await watchDevJobsOnce({ ...deps, listActiveSessions: async () => [session, { ...session, id: "ds2" }] });
	assert.equal(total.closed, 2);
	assert.equal(events.filter((e) => e.type === "shell_done").length, 2);
});

test("saída já transmitida (streamed): vigia emite só shell_done, sem reenviar o fim da saída", async () => {
	const done = { running: false, exitCode: 0, status: "exited", timedOut: false, stdout: "ok\n", stderr: "", durationMs: 10 };
	const streamed = setup({ a: done }, [{ ...job("a", 60_000), streamed: true }]);
	await reconcileSessionJobs(session, streamed.deps);
	assert.deepEqual(streamed.events.map((e) => e.type), ["shell_done"]);
});

test("shell_done é idempotente: job fechado por outro entre a leitura e a emissão não recebe segundo fim", async () => {
	const { deps, events } = setup({ a: { running: false, exitCode: 0, status: "exited", timedOut: false, stdout: "", stderr: "", durationMs: 10 } });
	let reads = 0;
	const result = await reconcileSessionJobs(session, { ...deps, listOpenJobs: async () => (reads++ === 0 ? [job("a", 60_000)] : []) });
	assert.equal(result.closed, 0);
	assert.equal(events.length, 0);
});

test("vigia com sonda: container sem jobs e nada rodando antes não consulta o banco; transição para zero ou erro da sonda consultam", async () => {
	const { deps } = setup({});
	let dbReads = 0;
	const options = { ...deps, listOpenJobs: async () => (dbReads++, []), listActiveSessions: async () => [session], state: new Map<string, number>() };
	let running: number | null = 0;
	const probeRunning = async () => running;
	await watchDevJobsOnce({ ...options, probeRunning }); // primeira passada: desconhecido, consulta
	assert.equal(dbReads, 1);
	await watchDevJobsOnce({ ...options, probeRunning });
	assert.equal(dbReads, 1, "0 jobs e 0 antes: sem consulta");
	running = 2;
	await watchDevJobsOnce({ ...options, probeRunning });
	assert.equal(dbReads, 2);
	running = 0;
	await watchDevJobsOnce({ ...options, probeRunning });
	assert.equal(dbReads, 3, "transição 2 -> 0 fecha o que terminou");
	running = null;
	await watchDevJobsOnce({ ...options, probeRunning });
	assert.equal(dbReads, 4, "sonda falhou: consulta por segurança");
});
