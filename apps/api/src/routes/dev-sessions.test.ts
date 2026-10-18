import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { createDevSessionRoutes } = await import("./dev-sessions.js");
const { aggregateDevSessionEvents } = await import("@workspace/db");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";

const session = (userId: string) => ({
	id: "ds1",
	userId,
	conversationId: "conv-a",
	repo: "octo/hello",
	branch: "feat/x",
	baseBranch: "main",
	status: "RUNNING" as const,
	tier: "small" as const,
	containerId: "secret-container-id",
	todos: [{ id: "1", content: "Rodar testes", status: "in_progress" as const }],
	lastError: "interno",
	createdAt: new Date("2026-10-17T10:00:00Z"),
	updatedAt: new Date("2026-10-17T10:05:00Z"),
	lastActiveAt: new Date("2026-10-17T10:05:00Z"),
});

function appFor(userId: string) {
	const stats = { commandsRun: 2, filesChanged: [{ path: "a.ts", added: 3, removed: 1 }], totalAdded: 3, totalRemoved: 1, lastActivityAt: "2026-10-17T10:05:00.000Z" };
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route(
		"/",
		createDevSessionRoutes({
			getOwnedConversation: (async (id: string, uid: string) => (id === "conv-a" && uid === USER_A ? { id } : null)) as never,
			listForConversation: (async (_c: string, uid: string) => (uid === USER_A ? [session(USER_A)] : [])) as never,
			getSession: (async (id: string, uid: string) => (id === "ds1" && uid === USER_A ? session(USER_A) : null)) as never,
			getStats: (async () => stats) as never,
		}),
	);
	return outer;
}

test("lista as sessões da conversa sem expor container nem erro interno", async () => {
	const res = await appFor(USER_A).request("/v1/dev-sessions?conversationId=conv-a");
	assert.equal(res.status, 200);
	const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
	assert.equal(body.sessions.length, 1);
	assert.deepEqual(Object.keys(body.sessions[0]!).sort(), ["baseBranch", "branch", "conversationId", "id", "lastActiveAt", "pr", "repo", "startedAt", "status", "tier"]);
	assert.equal(body.sessions[0]!.startedAt, "2026-10-17T10:00:00.000Z");
});

test("exige conversationId e respeita o dono da conversa", async () => {
	assert.equal((await appFor(USER_A).request("/v1/dev-sessions")).status, 400);
	assert.equal((await appFor(USER_B).request("/v1/dev-sessions?conversationId=conv-a")).status, 404);
});

test("detalhe traz tarefas e contadores; outro usuário recebe 404", async () => {
	const res = await appFor(USER_A).request("/v1/dev-sessions/ds1");
	assert.equal(res.status, 200);
	const body = (await res.json()) as { todos: unknown[]; stats: { commandsRun: number; totalAdded: number }; containerId?: string };
	assert.equal(body.todos.length, 1);
	assert.equal(body.stats.commandsRun, 2);
	assert.equal(body.stats.totalAdded, 3);
	assert.equal("containerId" in body, false);
	assert.equal((await appFor(USER_B).request("/v1/dev-sessions/ds1")).status, 404);
});

test("agregação soma edições por arquivo, conta comandos e acha a última atividade", () => {
	const t = (s: string) => new Date(s);
	const stats = aggregateDevSessionEvents([
		{ type: "shell_started", payload: { sessionId: "ds1" }, createdAt: t("2026-10-17T10:00:00Z") },
		{ type: "file_edit", payload: { path: "a.ts", added: 2, removed: 1 }, createdAt: t("2026-10-17T10:01:00Z") },
		{ type: "file_edit", payload: { path: "a.ts", added: 1, removed: 0 }, createdAt: t("2026-10-17T10:03:00Z") },
		{ type: "file_edit", payload: { path: "b.ts", added: 5, removed: 5 }, createdAt: t("2026-10-17T10:02:00Z") },
		{ type: "shell_started", payload: {}, createdAt: t("2026-10-17T10:02:30Z") },
	]);
	assert.equal(stats.commandsRun, 2);
	assert.deepEqual(stats.filesChanged, [{ path: "a.ts", added: 3, removed: 1 }, { path: "b.ts", added: 5, removed: 5 }]);
	assert.equal(stats.totalAdded, 8);
	assert.equal(stats.lastActivityAt, "2026-10-17T10:03:00.000Z");
	assert.equal(aggregateDevSessionEvents([]).lastActivityAt, null);
});

// ---------------------------------------------------------------------------
// Fase 4: histórico, parar comando/sessão, retomar e lista "Em andamento"
// ---------------------------------------------------------------------------

type Calls = { events: Array<{ runId: string; event: Record<string, unknown> }>; cancelled: string[]; updates: Array<Record<string, unknown>>; stopped: string[]; killed: Array<{ id: string; signal: string }>; ensured: string[] };

function controlApp(userId: string, opts: { running?: boolean; queued?: boolean; activeRuns?: string[]; status?: string; history?: unknown[]; openJobs?: Array<{ jobId: string; callId: string; cmd: string; startedAt: number }> } = {}) {
	const calls: Calls = { events: [], cancelled: [], updates: [], stopped: [], killed: [], ensured: [] };
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	const provider = {
		stop: async (id: string) => void calls.stopped.push(id),
		endpoint: async () => (opts.running === false ? null : { baseUrl: "http://x", token: "t" }),
		ensureRunning: async (input: { sessionId: string }) => {
			calls.ensured.push(input.sessionId);
			return opts.queued
				? { status: "queued", denied: { message: "sem vaga" } }
				: { status: "running", endpoint: { baseUrl: "http://x", token: "t" }, containerId: "c1", resumed: true };
		},
	};
	outer.route(
		"/",
		createDevSessionRoutes({
			getOwnedConversation: (async () => ({ id: "conv-a" })) as never,
			getSession: (async (id: string, uid: string) => (id === "ds1" && uid === USER_A ? { ...session(USER_A), status: opts.status ?? "RUNNING" } : null)) as never,
			listHistory: (async () => opts.history ?? []) as never,
			listActiveWork: (async (uid: string) => (uid === USER_A ? [{ kind: "dev", id: "ds1" }] : [])) as never,
			findJob: (async (_s: unknown, jobId: string) => (jobId === "j1" ? { callId: "call-1", startedAt: null } : null)) as never,
			getEventRunId: (async () => "run-1") as never,
			listActiveRunIds: (async () => opts.activeRuns ?? ["run-1", "run-2"]) as never,
			appendEvent: async (runId, event) => void calls.events.push({ runId, event: event as unknown as Record<string, unknown> }),
			updateSession: (async (_id: string, patch: Record<string, unknown>) => void calls.updates.push(patch)) as never,
			cancelRun: async (runId) => void calls.cancelled.push(runId),
			provider: () => provider as never,
			makeClient: () =>
				({
					execKill: async (id: string, signal: string) => void calls.killed.push({ id, signal }),
					execPoll: async () => ({ running: false, exitCode: null, durationMs: 1234 }),
				}) as never,
			killSettleMs: 0,
			jobs: ((prov: () => never) => ({
				listOpenJobs: async () => opts.openJobs ?? [],
				emit: async () => undefined,
				provider: prov,
				makeClient: () => ({ execPoll: async () => ({ running: true }) }) as never,
			})) as never,
		}),
	);
	return { app: outer, calls };
}

test("histórico: dono recebe eventos com a saída limitada ao fim; outro usuário 404; after inválido 400", async () => {
	const chunk = (callId: string, text: string, createdAt: string) => ({ id: createdAt, runId: "r1", seq: 1, type: "shell_output", payload: { sessionId: "ds1", callId, chunk: text }, createdAt });
	const big = "x".repeat(40 * 1024);
	const { app } = controlApp(USER_A, { history: [chunk("c", big, "2026-10-17T10:00:01.000Z"), chunk("c", big, "2026-10-17T10:00:02.000Z")] });
	const res = await app.request("/v1/dev-sessions/ds1/events");
	assert.equal(res.status, 200);
	const body = (await res.json()) as { events: Array<{ payload: { chunk: string } }>; nextAfter: string };
	assert.equal(body.events.length, 1, "só o fim cabe em 64KB");
	assert.match(body.events[0]!.payload.chunk, /início da saída omitido/);
	assert.equal(body.nextAfter, "2026-10-17T10:00:02.000Z");
	assert.equal((await app.request("/v1/dev-sessions/ds1/events?after=ontem")).status, 400);
	assert.equal((await controlApp(USER_B).app.request("/v1/dev-sessions/ds1/events")).status, 404);
});

test("parar comando: envia SIGTERM, registra shell_done killed e respeita o dono", async () => {
	const { app, calls } = controlApp(USER_A, { openJobs: OPEN_J1 });
	const res = await app.request("/v1/dev-sessions/ds1/jobs/j1/kill", { method: "POST" });
	assert.equal(res.status, 200);
	assert.deepEqual(calls.killed, [{ id: "j1", signal: "SIGTERM" }]);
	assert.equal(calls.events[0]!.runId, "run-1");
	assert.deepEqual({ type: calls.events[0]!.event.type, callId: calls.events[0]!.event.callId, endedReason: calls.events[0]!.event.endedReason }, { type: "shell_done", callId: "call-1", endedReason: "killed" });
	assert.equal((await app.request("/v1/dev-sessions/ds1/jobs/inexistente/kill", { method: "POST" })).status, 404);
	assert.equal((await controlApp(USER_B).app.request("/v1/dev-sessions/ds1/jobs/j1/kill", { method: "POST" })).status, 404);
	const forced = controlApp(USER_A, { openJobs: OPEN_J1 });
	await forced.app.request("/v1/dev-sessions/ds1/jobs/j1/kill", { method: "POST", body: JSON.stringify({ force: true }) });
	assert.equal(forced.calls.killed[0]!.signal, "SIGKILL");
	assert.equal((await controlApp(USER_A, { running: false }).app.request("/v1/dev-sessions/ds1/jobs/j1/kill", { method: "POST" })).status, 200, "sem container: job perdido, só limpa");
});

test("parar sessão: cancela os runs ativos, para o container, grava STOPPED e emite o status", async () => {
	const { app, calls } = controlApp(USER_A);
	const res = await app.request("/v1/dev-sessions/ds1/stop", { method: "POST" });
	assert.equal(res.status, 200);
	assert.deepEqual(((await res.json()) as { cancelledRuns: string[] }).cancelledRuns, ["run-1", "run-2"]);
	assert.deepEqual(calls.cancelled, ["run-1", "run-2"]);
	assert.deepEqual(calls.stopped, ["ds1"]);
	assert.equal(calls.updates[0]!.status, "STOPPED");
	assert.deepEqual({ type: calls.events[0]!.event.type, status: calls.events[0]!.event.status, sessionId: calls.events[0]!.event.sessionId }, { type: "dev_session_status", status: "STOPPED", sessionId: "ds1" });
	assert.equal((await controlApp(USER_B).app.request("/v1/dev-sessions/ds1/stop", { method: "POST" })).status, 404);
});

test("parar sessão com keepRun=1 não cancela o run", async () => {
	const { app, calls } = controlApp(USER_A);
	await app.request("/v1/dev-sessions/ds1/stop?keepRun=1", { method: "POST" });
	assert.deepEqual(calls.cancelled, []);
	assert.deepEqual(calls.stopped, ["ds1"]);
});

test("retomar: religa o container e emite RUNNING; sem vaga 409; expirada 410; outro usuário 404", async () => {
	const ok = controlApp(USER_A, { status: "STOPPED" });
	const res = await ok.app.request("/v1/dev-sessions/ds1/resume", { method: "POST" });
	assert.equal(res.status, 200);
	assert.deepEqual(ok.calls.ensured, ["ds1"]);
	assert.equal(ok.calls.updates[0]!.status, "RUNNING");
	assert.equal(ok.calls.events[0]!.event.status, "RUNNING");
	assert.equal((await controlApp(USER_A, { status: "STOPPED", queued: true }).app.request("/v1/dev-sessions/ds1/resume", { method: "POST" })).status, 409);
	assert.equal((await controlApp(USER_A, { status: "EXPIRED" }).app.request("/v1/dev-sessions/ds1/resume", { method: "POST" })).status, 410);
	assert.equal((await controlApp(USER_B, { status: "STOPPED" }).app.request("/v1/dev-sessions/ds1/resume", { method: "POST" })).status, 404);
});

test("lista ativa: escopo do usuário e rota não confundida com :id", async () => {
	const own = await controlApp(USER_A).app.request("/v1/dev-sessions/active");
	assert.equal(own.status, 200);
	assert.equal(((await own.json()) as { items: unknown[] }).items.length, 1);
	const other = await controlApp(USER_B).app.request("/v1/dev-sessions/active");
	assert.equal(((await other.json()) as { items: unknown[] }).items.length, 0);
});

// ---------------------------------------------------------------------------
// Fase 5: PR e CI
// ---------------------------------------------------------------------------

const PR_ROW = { number: 42, url: "https://github.com/octo/hello/pull/42", state: "open" as const, base: "main", head: "feat/x", headSha: "aaa111", title: "Corrige" };
const snapshotOf = (checks: Array<{ name: string; status: string; conclusion: string | null }>, headSha = "aaa111") => ({
	pr: { ...PR_ROW, headSha },
	checks,
	summary: checks.some((c) => c.status !== "completed") ? "pending" : "passing",
});

let ciSeq = 0;
function ciApp(opts: { status?: string; pr?: typeof PR_ROW | null; snapshots: unknown[]; token?: string | null }) {
	const sid = `ds-ci-${++ciSeq}`;
	const events: Array<Record<string, unknown>> = [];
	const updates: Array<Record<string, unknown>> = [];
	const fetchCalls: Array<{ token: string | undefined; repo: string; number: number }> = [];
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: USER_A } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	let index = 0;
	outer.route(
		"/",
		createDevSessionRoutes({
			getSession: (async () => ({ ...session(USER_A), id: sid, status: opts.status ?? "RUNNING", pr: opts.pr === undefined ? PR_ROW : opts.pr })) as never,
			getStats: (async () => ({ commandsRun: 0, filesChanged: [], totalAdded: 0, totalRemoved: 0, lastActivityAt: null })) as never,
			getEventRunId: (async () => "run-1") as never,
			appendEvent: async (_runId, event) => void events.push(event as unknown as Record<string, unknown>),
			updateSession: (async (_id: string, patch: Record<string, unknown>) => void updates.push(patch)) as never,
			getGithubToken: async () => (opts.token === undefined ? "ghp_segredo" : opts.token),
			fetchSnapshot: (async (token: string | undefined, repo: string, number: number) => {
				fetchCalls.push({ token, repo, number });
				return opts.snapshots[Math.min(index++, opts.snapshots.length - 1)];
			}) as never,
		}),
	);
	return { app: outer, events, updates, fetchCalls, refresh: `/v1/dev-sessions/${sid}/ci/refresh`, detail: `/v1/dev-sessions/${sid}` };
}

test("resumo da sessão inclui o PR (ou null)", async () => {
	const withPr = ciApp({ snapshots: [] });
	const detail = await withPr.app.request(withPr.detail);
	assert.equal(((await detail.json()) as { pr: { number: number } }).pr.number, 42);
	const noPr = ciApp({ pr: null, snapshots: [] });
	const none = await noPr.app.request(noPr.detail);
	assert.equal(((await none.json()) as { pr: unknown }).pr, null);
});

test("ci/refresh: lê o GitHub com o token do usuário, grava dev_pr e dev_ci e devolve o resumo", async () => {
	const pending = snapshotOf([{ name: "build", status: "in_progress", conclusion: null }]);
	const { app, events, updates, fetchCalls, refresh } = ciApp({ snapshots: [pending] });
	const res = await app.request(refresh, { method: "POST" });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { summary: string; checks: unknown[] };
	assert.equal(body.summary, "pending");
	assert.deepEqual(fetchCalls, [{ token: "ghp_segredo", repo: "octo/hello", number: 42 }]);
	assert.equal(JSON.stringify(body).includes("ghp_segredo"), false);
	assert.deepEqual(events.map((e) => e.type), ["dev_ci"], "PR igual ao salvo: só o dev_ci");
	assert.equal(updates.length, 0);
});

test("ci/refresh: PR mesclado atualiza a sessão e emite dev_pr; resposta repetida em <5s vem do cache sem novo evento", async () => {
	const merged = { ...snapshotOf([{ name: "build", status: "completed", conclusion: "success" }], "bbb222"), pr: { ...PR_ROW, state: "merged", headSha: "bbb222" } };
	const { app, events, updates, fetchCalls, refresh } = ciApp({ snapshots: [merged] });
	const first = await app.request(refresh, { method: "POST" });
	assert.equal(first.status, 200);
	assert.deepEqual(events.map((e) => e.type), ["dev_pr", "dev_ci"]);
	assert.equal((updates[0]!.pr as { state: string }).state, "merged");
	const second = await app.request(refresh, { method: "POST" });
	assert.equal(second.status, 200);
	assert.equal(events.length, 2);
	assert.equal(fetchCalls.length, 1);
});

test("ci/refresh: sem PR 409; sessão parada 409 com stopped; erro do GitHub vira 502 genérico", async () => {
	const noPr2 = ciApp({ pr: null, snapshots: [] });
	assert.equal((await noPr2.app.request(noPr2.refresh, { method: "POST" })).status, 409);
	const stoppedApp = ciApp({ status: "STOPPED", snapshots: [] });
	const stopped = await stoppedApp.app.request(stoppedApp.refresh, { method: "POST" });
	assert.equal(stopped.status, 409);
	assert.equal(((await stopped.json()) as { stopped?: boolean }).stopped, true);
	const failApp = ciApp({ snapshots: [{ error: { status: 401, message: "Bad credentials ghp_segredo" } }] });
	const failing = await failApp.app.request(failApp.refresh, { method: "POST" });
	assert.equal(failing.status, 502);
	assert.equal((await failing.text()).includes("ghp_segredo"), false);
});

test("ci/refresh: sem token tenta como público; dono errado recebe 404", async () => {
	const { app, fetchCalls, refresh } = ciApp({ token: null, snapshots: [snapshotOf([])] });
	assert.equal((await app.request(refresh, { method: "POST" })).status, 200);
	assert.equal(fetchCalls[0]!.token, undefined);
	const other = new Hono<AuthEnv>();
	other.use("*", async (c, next) => {
		c.set("session", { user: { id: USER_B } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	other.route("/", createDevSessionRoutes({ getSession: (async () => null) as never }));
	assert.equal((await other.request("/v1/dev-sessions/ds1/ci/refresh", { method: "POST" })).status, 404);
});

const OPEN_J1 = [{ jobId: "j1", callId: "call-1", cmd: "sleep 300", startedAt: Date.now() - 1_000 }];
const OPEN = [{ jobId: "j9", callId: "call-9", cmd: "pnpm install", startedAt: Date.now() - 600_000 }];

test("parar a sessão fecha os comandos em segundo plano abertos (stopped)", async () => {
	const { app, calls } = controlApp(USER_A, { openJobs: OPEN });
	const res = await app.request("/v1/dev-sessions/ds1/stop", { method: "POST" });
	assert.equal(res.status, 200);
	const done = calls.events.filter((e) => e.event.type === "shell_done");
	assert.equal(done.length, 1);
	assert.equal(done[0]!.event.endedReason, "stopped");
	assert.equal(done[0]!.event.jobId, "j9");
});

test("hidratar o histórico de sessão parada marca o job aberto como perdido; sessão rodando e conhecida pelo container não mexe", async () => {
	const stopped = controlApp(USER_A, { openJobs: OPEN, status: "STOPPED", running: false, activeRuns: [] });
	assert.equal((await stopped.app.request("/v1/dev-sessions/ds1/events")).status, 200);
	const lost = stopped.calls.events.filter((e) => e.event.type === "shell_done");
	assert.equal(lost.length, 1);
	assert.equal(lost[0]!.event.endedReason, "lost");

	const live = controlApp(USER_A, { openJobs: OPEN });
	await live.app.request("/v1/dev-sessions/ds1/events");
	assert.equal(live.calls.events.filter((e) => e.event.type === "shell_done").length, 0, "container ainda roda o job");
});

test("hidratar o histórico com run do agente ativo não reconcilia (evita shell_done/saída duplicados)", async () => {
	const active = controlApp(USER_A, { openJobs: OPEN, status: "STOPPED", running: false });
	assert.equal((await active.app.request("/v1/dev-sessions/ds1/events")).status, 200);
	assert.equal(active.calls.events.length, 0);
});

test("parar um job perdido (sem container) só limpa o card", async () => {
	const { app, calls } = controlApp(USER_A, { running: false, openJobs: OPEN_J1 });
	const res = await app.request("/v1/dev-sessions/ds1/jobs/j1/kill", { method: "POST" });
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, running: false, lost: true });
	assert.equal(calls.events.at(-1)!.event.endedReason, "lost");
	assert.equal(calls.killed.length, 0);
});

test("parar comando que o callback do container já fechou não emite shell_done duplicado", async () => {
	const { app, calls } = controlApp(USER_A, { openJobs: [] });
	assert.equal((await app.request("/v1/dev-sessions/ds1/jobs/j1/kill", { method: "POST" })).status, 200);
	assert.equal(calls.killed.length, 1);
	assert.equal(calls.events.length, 0);
});
