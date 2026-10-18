import assert from "node:assert/strict";
import test from "node:test";
import type { DevSessionEvent } from "@workspace/shared";

import type { ActiveWorkItemResponse } from "@/lib/atlas-api";
import { buildActiveRows } from "./active-work";
import { dedupeCards } from "@/lib/thread-merge";
import { contextSummaryCard, insertContextDividers } from "./cards";
import { applyContextCompacted, applyDevHistory, applyDevSessionEvent, hydrateDevSession, type DevHistoryItem, type DevSessionMap } from "./reducer";

const S = "s1";
const at = (n: number) => new Date(Date.UTC(2026, 9, 17, 10, 0, n)).toISOString();

function history(): DevHistoryItem[] {
	const ev = (seq: number, type: DevSessionEvent["type"] | "context_compacted", payload: Record<string, unknown>): DevHistoryItem => ({
		runId: "r1",
		seq,
		type,
		payload: { sessionId: S, ...payload },
		createdAt: at(seq),
	});
	return [
		ev(1, "dev_session_status", { status: "RUNNING", tier: "small", repo: "o/r", branch: "b" }),
		ev(2, "shell_started", { callId: "c1", jobId: "j1", cmd: "pnpm test", cwd: "/w", startedAt: at(2) }),
		ev(3, "shell_output", { callId: "c1", jobId: "j1", chunk: "ok\n" }),
		ev(4, "shell_done", { callId: "c1", jobId: "j1", exitCode: 0, durationMs: 900, endedReason: "exit" }),
		ev(5, "file_edit", { callId: "e1", path: "a.ts", diff: "-a\n+b", added: 1, removed: 1 }),
		ev(6, "context_compacted", { before: 118_000, after: 42_000 }),
		ev(7, "dev_session_status", { status: "STOPPED", tier: "small" }),
	];
}

test("histórico persistido monta comandos, diffs, resumo de contexto e status", () => {
	const map = applyDevHistory({}, history());
	const view = map[S]!;
	assert.equal(view.commands.length, 1);
	assert.equal(view.commands[0]!.output, "ok\n");
	assert.equal(view.commands[0]!.status, "done");
	assert.equal(view.edits.length, 1);
	assert.equal(view.compactions.length, 1);
	assert.deepEqual([view.compactions[0]!.before, view.compactions[0]!.after], [118_000, 42_000]);
	assert.equal(view.status, "STOPPED");
});

test("reaplicar o histórico (ou receber o mesmo evento ao vivo) não duplica nada", () => {
	const once = applyDevHistory({}, history());
	const twice = applyDevHistory(once, history());
	assert.equal(twice[S]!.commands[0]!.output, "ok\n");
	assert.equal(twice[S]!.edits.length, 1);
	assert.equal(twice[S]!.compactions.length, 1);
	const live = applyContextCompacted(twice, { sessionId: S, before: 118_000, after: 42_000 }, { at: 1, runId: "r1", seq: 6 });
	assert.equal(live, twice);
});

test("hidratação autoritativa: o status da API vence o do histórico", () => {
	const map = applyDevHistory({}, history().slice(0, 4));
	assert.equal(map[S]!.status, "RUNNING");
	const api = { id: S, status: "STOPPED" as const, startedAt: at(0), lastActiveAt: at(60) };
	assert.equal(hydrateDevSession(map, api)[S]!.status, "RUNNING");
	assert.equal(hydrateDevSession(map, api, { authoritativeStatus: true })[S]!.status, "STOPPED");
});

test("resumo de contexto sem sessão (run que não é de código) não cria sessão", () => {
	const map: DevSessionMap = applyContextCompacted({}, { before: 10, after: 5 }, { at: 1 });
	assert.deepEqual(map, {});
});

test("divisores de contexto entram antes da primeira mensagem posterior e não repetem", () => {
	const thread = [
		{ id: "m1", kind: "user" as const, text: "oi", createdAt: at(1) },
		{ id: "m2", kind: "assistant" as const, text: "ok", createdAt: at(10) },
	];
	const events = [{ runId: "r1", seq: 6, createdAt: at(6), payload: { before: 100, after: 40 } }];
	const once = insertContextDividers(thread as never, events);
	assert.deepEqual(once.map((m) => m.id), ["m1", contextSummaryCard("r1:6", 0, 0).id, "m2"]);
	assert.equal(insertContextDividers(once, events).length, 3);
});

test("divisores de contexto empilhados colapsam em um só e não voltam ao reidratar", () => {
	const thread = [
		{ id: "m1", kind: "user" as const, text: "oi", createdAt: at(1) },
		{ id: "m2", kind: "assistant" as const, text: "ok", createdAt: at(20) },
	];
	const events = [3, 4, 5, 6].map((seq) => ({ runId: "r1", seq, createdAt: at(seq), payload: { before: 100, after: 40 } }));
	const once = insertContextDividers(thread as never, events);
	assert.equal(once.filter((m) => m.kind === "context-summary").length, 1);
	const card = once.find((m) => m.kind === "context-summary");
	assert.equal(card?.kind === "context-summary" && card.mergedIds?.length, 4);
	const twice = insertContextDividers(once, events);
	assert.deepEqual(twice.map((m) => m.id), once.map((m) => m.id));
	assert.equal(dedupeCards([...once, ...once]).filter((m) => m.kind === "context-summary").length, 1);
});

const dev = (over: Partial<Extract<ActiveWorkItemResponse, { kind: "dev" }>>): ActiveWorkItemResponse => ({
	kind: "dev",
	id: "d1",
	conversationId: "c1",
	conversationTitle: "Dev bot",
	botId: "b1",
	status: "RUNNING",
	repo: "octo/hello",
	branch: "feat/x",
	startedAt: at(0),
	lastActiveAt: at(30),
	awaitingApproval: false,
	...over,
});

test("Em andamento: trabalhando primeiro, terminadas só se não vistas, aprovação pendente", () => {
	const items: ActiveWorkItemResponse[] = [
		dev({ id: "done-seen", status: "STOPPED" }),
		dev({ id: "done-new", status: "STOPPED", lastActiveAt: at(50) }),
		dev({ id: "run", startedAt: at(5), awaitingApproval: true }),
		{ kind: "subagent", id: "sub1", conversationId: "c2", conversationTitle: "Pesquisa", botId: "b2", title: "Mapear usos", startedAt: at(20), awaitingApproval: false },
	];
	const { rows, running, unread } = buildActiveRows(items, { "done-seen": Date.parse(at(40)), "done-new": Date.parse(at(40)) });
	assert.deepEqual(rows.map((row) => row.item.id), ["sub1", "run", "done-new"]);
	assert.equal(running, 2);
	assert.equal(unread, 1);
	assert.equal(rows.find((row) => row.item.id === "run")!.state, "waiting");
	assert.equal(rows.find((row) => row.item.id === "run")!.title, "octo/hello · feat/x");
	assert.equal(rows.find((row) => row.item.id === "done-new")!.unread, true);
});

test("Em andamento: sem itens, lista vazia", () => {
	assert.deepEqual(buildActiveRows([], {}), { rows: [], running: 0, unread: 0 });
});
