/**
 * Agenda do v4 no worker (F4.2), com db falso que filtra por dono como o real.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/agenda.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgendaCapability, createAgendaRunCapability, type ToolContext } from "@workspace/agent";
import type { AgendaGrant, AgendaItemRecord } from "@workspace/db";
import { DEFAULT_PROACTIVE_SETTINGS, type AgendaPlan } from "@workspace/shared";
import { createV4Agenda, toAgendaView, type V4AgendaDeps } from "./agenda.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");

function fakeDb() {
	const rows = new Map<string, AgendaItemRecord>();
	const created: Array<{ userId: string; botId: string; grant: AgendaGrant; sourceRunId?: string | null }> = [];
	let seq = 0;
	const deps: V4AgendaDeps = {
		loadSettings: async () => ({ ...DEFAULT_PROACTIVE_SETTINGS, enabled: true }),
		create: async (input) => {
			created.push({ userId: input.userId, botId: input.botId, grant: input.grant, sourceRunId: input.sourceRunId });
			const plan = input.plan as AgendaPlan;
			const item: AgendaItemRecord = { id: `i${++seq}`, userId: input.userId, botId: input.botId, conversationId: null, kind: plan.kind, status: "pending", note: plan.note, dueAt: plan.dueAt, requestedFor: plan.requestedFor, intervalMinutes: plan.intervalMinutes, untilAt: plan.untilAt, maxRuns: plan.maxRuns, runCount: 0, eventFilter: plan.eventFilter, noChangeStreak: 0, ignoredStreak: 0, missingResults: 0, lastResult: null, lastNoticeAt: null, grant: input.grant, runId: null, endReason: null, sourceRunId: input.sourceRunId ?? null, reservedUntil: null, createdAt: NOW };
			rows.set(item.id, item);
			return { ok: true, item, duplicate: false };
		},
		list: async (userId) => [...rows.values()].filter((r) => r.userId === userId && (r.status === "pending" || r.status === "paused")),
		change: async (userId, id, action) => {
			const row = rows.get(id);
			if (!row || row.userId !== userId) return null;
			row.status = action === "pause" ? "paused" : action === "resume" ? "pending" : "cancelled";
			return row;
		},
		record: async (input) => {
			const row = [...rows.values()].find((r) => r.userId === input.userId && r.runId === input.runId);
			if (!row) return { ok: false, error: "No agenda item is attached to this run." };
			return { ok: true, item: row, duplicate: false };
		},
	};
	return { deps, rows, created };
}

const ctx = (ownerId: string, runId = "run-1"): ToolContext => ({ runId, ownerId, ports: { clock: { now: () => NOW } } as unknown as ToolContext["ports"] });

test("a criação guarda a política do run (autonomia e regras) e o dono vem do run, não dos argumentos", async () => {
	const { deps, created } = fakeDb();
	const agenda = createV4Agenda({ botId: "bot-1", policy: { autonomy: "always_ask", rules: [{ match: "web_*", verdict: "deny" }] }, deps });
	const remind = createAgendaCapability(agenda).tools.find((t) => t.name === "remind_me")!;
	const out = await remind.run({ note: "Ligar para a Ana", when: "2026-11-06T10:00" }, ctx("user-a", "run-9"));
	assert.equal(out.ok, true);
	assert.deepEqual(created, [{ userId: "user-a", botId: "bot-1", grant: { autonomy: "always_ask", rules: [{ match: "web_*", verdict: "deny" }] }, sourceRunId: "run-9" }]);
});

test("IDOR: o dono B não lista, não pausa nem cancela o item do A, e a resposta é a de item inexistente", async () => {
	const { deps, rows } = fakeDb();
	const agenda = createV4Agenda({ botId: "bot-1", policy: { autonomy: "balanced", rules: [] }, deps });
	const tools = Object.fromEntries(createAgendaCapability(agenda).tools.map((t) => [t.name, t]));
	await tools.watch!.run({ note: "Preço do notebook do A", everyMinutes: 120 }, ctx("user-a"));
	const listB = await tools.agenda_list!.run({}, ctx("user-b"));
	assert.equal(listB.ok && listB.summary, "No active agenda items.");
	const id = [...rows.keys()][0]!;
	for (const action of ["pause", "cancel", "resume"] as const) {
		const out = await tools.agenda_change!.run({ id, action }, ctx("user-b"));
		assert.equal(out.ok, false);
	}
	assert.equal(rows.get(id)?.status, "pending");
	const listA = await tools.agenda_list!.run({}, ctx("user-a"));
	assert.match(listA.ok ? listA.summary : "", /Preço do notebook do A/);
});

test("agenda_result só grava no item do run do próprio dono", async () => {
	const { deps, rows } = fakeDb();
	const agenda = createV4Agenda({ botId: "bot-1", policy: { autonomy: "balanced", rules: [] }, deps });
	await createAgendaCapability(agenda).tools.find((t) => t.name === "watch")!.run({ note: "vigia", everyMinutes: 120 }, ctx("user-a"));
	const item = [...rows.values()][0]!;
	item.runId = "run-wake";
	const result = createAgendaRunCapability(agenda).tools[0]!;
	assert.equal((await result.run({ outcome: "no_change" }, ctx("user-b", "run-wake"))).ok, false);
	assert.equal((await result.run({ outcome: "no_change" }, ctx("user-a", "run-wake"))).ok, true);
});

test("toAgendaView entrega datas em ISO e o filtro do evento, sem expor dono, grant nem run", () => {
	const view = toAgendaView({ id: "i1", userId: "u", botId: "b", conversationId: "c", kind: "intent", status: "pending", note: "n", dueAt: NOW, requestedFor: NOW, intervalMinutes: null, untilAt: NOW, maxRuns: null, runCount: 2, eventFilter: { source: "email", from: "a.com" }, noChangeStreak: 0, ignoredStreak: 0, missingResults: 0, lastResult: null, lastNoticeAt: null, grant: { autonomy: "balanced", rules: [] }, runId: "r", endReason: null, sourceRunId: null, reservedUntil: null, createdAt: NOW });
	assert.deepEqual(view, { id: "i1", kind: "intent", status: "pending", note: "n", nextRunAt: NOW.toISOString(), everyMinutes: null, untilAt: NOW.toISOString(), runCount: 2, maxRuns: null, eventFilter: { source: "email", from: "a.com" }, endReason: null });
});
