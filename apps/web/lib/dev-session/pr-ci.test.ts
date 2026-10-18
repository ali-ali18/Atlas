import assert from "node:assert/strict";
import test from "node:test";
import type { DevCiCheck, DevSessionEvent } from "@workspace/shared";

import { CI_POLL_DELAYS_MS, CI_POLL_MAX_MS, ciPollDelay, runCiPoll, shouldPollCi, type CiPollDeps } from "./ci-poll";
import {
	applyDevHistory,
	applyDevSessionEvent,
	devPrCardText,
	hydrateDevSession,
	type DevSessionMap,
	type DevSessionView,
} from "./reducer";

const S = "s1";
const PR = { number: 42, url: "https://github.com/octo/hello/pull/42", state: "open" as "open" | "draft" | "merged" | "closed", title: "Corrige", base: "main", head: "fix/x", headSha: "aaa" };
const check = (name: string, status: DevCiCheck["status"], conclusion: string | null): DevCiCheck => ({ name, status, conclusion });

function apply(events: Array<[DevSessionEvent, { at: number; seq?: number; runId?: string }?]>, start: DevSessionMap = {}) {
	let map = start;
	let at = 1_000;
	for (const [event, meta] of events) map = applyDevSessionEvent(map, event, meta ?? { at: (at += 1_000) });
	return map;
}

test("dev_pr cria o PR da sessão e dev_ci guarda os checks com o resumo", () => {
	const map = apply([
		[{ type: "dev_session_status", sessionId: S, status: "RUNNING", tier: "small" }],
		[{ type: "dev_pr", sessionId: S, ...PR }],
		[{ type: "dev_ci", sessionId: S, checks: [check("build", "completed", "success"), check("test", "in_progress", null)], summary: "pending" }],
	]);
	const view = map[S]!;
	assert.deepEqual(view.pr, PR);
	assert.equal(view.ci?.summary, "pending");
	assert.equal(view.ci?.checks.length, 2);
});

test("dev_pr atualiza estado e commit; outro PR zera os checks do anterior", () => {
	const map = apply([
		[{ type: "dev_pr", sessionId: S, ...PR }],
		[{ type: "dev_ci", sessionId: S, checks: [check("build", "completed", "failure")], summary: "failing" }],
		[{ type: "dev_pr", sessionId: S, ...PR, state: "merged", headSha: "bbb" }],
	]);
	assert.equal(map[S]!.pr?.state, "merged");
	assert.equal(map[S]!.pr?.headSha, "bbb");
	assert.equal(map[S]!.ci?.summary, "failing", "mesmo PR mantém os checks");
	const other = applyDevSessionEvent(map, { type: "dev_pr", sessionId: S, ...PR, number: 43 }, { at: 9_000 });
	assert.equal(other[S]!.ci, undefined);
});

test("replays com seq repetido não duplicam nem regridem o estado", () => {
	const meta = { at: 1_000, seq: 5, runId: "r1" };
	let map = applyDevSessionEvent({}, { type: "dev_ci", sessionId: S, checks: [check("a", "completed", "success")], summary: "passing" }, meta);
	map = applyDevSessionEvent(map, { type: "dev_ci", sessionId: S, checks: [check("a", "in_progress", null)], summary: "pending" }, { ...meta, seq: 4 });
	assert.equal(map[S]!.ci?.summary, "passing");
});

test("o histórico persistido reconstrói PR e checks e a API hidrata o PR quando não há eventos", () => {
	const history = [
		{ runId: "r1", seq: 1, type: "dev_pr", payload: { sessionId: S, ...PR }, createdAt: "2026-10-19T10:00:00.000Z" },
		{ runId: "r1", seq: 2, type: "dev_ci", payload: { sessionId: S, checks: [check("build", "completed", "success")], summary: "passing" }, createdAt: "2026-10-19T10:01:00.000Z" },
	];
	const map = applyDevHistory({}, history);
	assert.equal(map[S]!.pr?.number, 42);
	assert.equal(map[S]!.ci?.summary, "passing");
	const hydrated = hydrateDevSession({}, { id: "s2", status: "RUNNING", pr: PR });
	assert.equal(hydrated.s2!.pr?.url, PR.url);
	const keepsEvents = hydrateDevSession(map, { id: S, status: "RUNNING", pr: { ...PR, state: "closed" } });
	assert.equal(keepsEvents[S]!.pr?.state, "open", "eventos já aplicados têm prioridade");
});

test("texto da linha 2 do cartão: PR #42 · checks ✓/✗/…, mesclada e fechada", () => {
	const view = (state: typeof PR.state, summary?: "passing" | "failing" | "pending" | "none"): Pick<DevSessionView, "pr" | "ci"> => ({
		pr: { ...PR, state },
		...(summary ? { ci: { checks: [], summary, at: 0 } } : {}),
	});
	assert.equal(devPrCardText({}), null);
	assert.equal(devPrCardText(view("open", "passing")), "PR #42 · checks ✓");
	assert.equal(devPrCardText(view("draft", "failing")), "PR #42 · checks ✗");
	assert.equal(devPrCardText(view("open", "pending")), "PR #42 · checks …");
	assert.equal(devPrCardText(view("open", "none")), "PR #42");
	assert.equal(devPrCardText(view("open")), "PR #42");
	assert.equal(devPrCardText(view("merged", "passing")), "PR #42 · mesclada");
	assert.equal(devPrCardText(view("closed")), "PR #42 · fechada");
});

// ----- consulta periódica -----

test("intervalos crescem e estabilizam em 60 s", () => {
	assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(ciPollDelay), [...CI_POLL_DELAYS_MS, 60_000, 60_000]);
	assert.ok(ciPollDelay(0) < ciPollDelay(3));
});

test("só consulta com PR aberto, sessão viva e checks pendentes (ou ainda sem checks, por poucas tentativas)", () => {
	const v = (status: DevSessionView["status"], state: typeof PR.state, summary?: "passing" | "failing" | "pending" | "none") => ({ status, pr: { state }, ...(summary ? { ci: { summary } } : {}) });
	assert.equal(shouldPollCi(undefined), false);
	assert.equal(shouldPollCi({ status: "RUNNING" }), false, "sem PR");
	assert.equal(shouldPollCi(v("RUNNING", "open")), true, "PR sem leitura de checks ainda");
	assert.equal(shouldPollCi(v("RUNNING", "open", "pending")), true);
	assert.equal(shouldPollCi(v("RUNNING", "open", "passing")), false);
	assert.equal(shouldPollCi(v("RUNNING", "open", "failing")), false);
	assert.equal(shouldPollCi(v("IDLE", "draft", "pending")), true);
	assert.equal(shouldPollCi(v("STOPPED", "open", "pending")), false, "cancela quando a sessão para");
	assert.equal(shouldPollCi(v("EXPIRED", "open", "pending")), false);
	assert.equal(shouldPollCi(v("RUNNING", "merged", "pending")), false);
	assert.equal(shouldPollCi(v("RUNNING", "open", "none"), 0), true);
	assert.equal(shouldPollCi(v("RUNNING", "open", "none"), 6), false);
});

type PollView = NonNullable<ReturnType<CiPollDeps["getView"]>>;
const pending = (summary: "pending" | "passing" | "failing" = "pending", status: DevSessionView["status"] = "RUNNING"): PollView => ({ status, pr: { state: "open" }, ci: { summary } });

function pollHarness(views: PollView[]) {
	const calls: string[] = [];
	const sleeps: number[] = [];
	let clock = 0;
	let index = 0;
	const deps: CiPollDeps = {
		getView: () => views[Math.min(index, views.length - 1)],
		refresh: async (id) => {
			calls.push(id);
			index += 1;
		},
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
		now: () => clock,
		isHidden: () => false,
	};
	return { deps, calls, sleeps };
}

test("a consulta repete com intervalos crescentes e termina quando os checks concluem", async () => {
	const h = pollHarness([pending(), pending(), pending(), pending("passing")]);
	const result = await runCiPoll(S, new AbortController().signal, h.deps);
	assert.equal(result, "done");
	assert.equal(h.calls.length, 3);
	assert.deepEqual(h.sleeps, [1_500, ciPollDelay(1), ciPollDelay(2), ciPollDelay(3)]);
});

test("a consulta para quando a sessão para e respeita o limite de 30 minutos", async () => {
	const stopped = pollHarness([pending(), pending("pending", "STOPPED")]);
	assert.equal(await runCiPoll(S, new AbortController().signal, stopped.deps), "stopped");
	assert.equal(stopped.calls.length, 1);
	const forever = pollHarness([pending()]);
	const result = await runCiPoll(S, new AbortController().signal, forever.deps);
	assert.equal(result, "timeout");
	assert.ok(forever.sleeps.reduce((n, ms) => n + ms, 0) <= CI_POLL_MAX_MS + 60_000);
	assert.ok(forever.calls.length < 60, "limitada: no máximo algumas dezenas de chamadas em 30 min");
});

test("aba escondida não chama o servidor; 409 encerra; falhas seguidas desistem; abort cancela", async () => {
	const hidden = pollHarness([pending()]);
	hidden.deps.isHidden = () => true;
	assert.equal(await runCiPoll(S, new AbortController().signal, hidden.deps), "timeout");
	assert.equal(hidden.calls.length, 0);

	const conflict = pollHarness([pending()]);
	conflict.deps.refresh = async () => {
		throw Object.assign(new Error("conflito"), { status: 409 });
	};
	assert.equal(await runCiPoll(S, new AbortController().signal, conflict.deps), "stopped");

	const failing = pollHarness([pending()]);
	let attempts = 0;
	failing.deps.refresh = async () => {
		attempts += 1;
		throw new Error("rede");
	};
	assert.equal(await runCiPoll(S, new AbortController().signal, failing.deps), "failed");
	assert.equal(attempts, 5);

	const controller = new AbortController();
	const aborting = pollHarness([pending()]);
	aborting.deps.sleep = async () => {
		controller.abort();
		throw new Error("aborted");
	};
	assert.equal(await runCiPoll(S, controller.signal, aborting.deps), "aborted");
});
