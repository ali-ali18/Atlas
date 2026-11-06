/**
 * Run de agenda dentro do processador (F4.3), com db falso.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/agenda-run.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgendaItemRecord } from "@workspace/db";
import { DEFAULT_PROACTIVE_SETTINGS } from "@workspace/shared";
import { agendaObjective } from "./agenda-wake.js";
import { closeAgendaRun, loadAgendaRunContext, type AgendaRunDb } from "./agenda-run.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const item = (over: Partial<AgendaItemRecord> = {}): AgendaItemRecord => ({
	id: "i1", userId: "user-a", botId: "bot-1", conversationId: "conv-1", kind: "watch", status: "pending", note: "Ver o preço do notebook X", dueAt: NOW, requestedFor: NOW,
	intervalMinutes: 120, untilAt: new Date("2026-11-19T12:00:00.000Z"), maxRuns: 10, runCount: 3, eventFilter: null, noChangeStreak: 0, ignoredStreak: 0, missingResults: 0,
	lastResult: { runId: "run-0", outcome: "no_change", at: "2026-11-05T09:00:00.000Z", memo: "R$ 4.990" }, lastNoticeAt: null, grant: { autonomy: "always_ask", rules: [] }, runId: "run-1", endReason: null, sourceRunId: null, reservedUntil: null, createdAt: NOW, ...over,
});
const db = (rows: AgendaItemRecord[], finalize?: AgendaRunDb["finalize"]): AgendaRunDb => ({
	getByRunId: async (userId, runId) => rows.find((r) => r.userId === userId && r.runId === runId) ?? null,
	loadSettings: async () => ({ ...DEFAULT_PROACTIVE_SETTINGS, enabled: true }),
	finalize: finalize ?? (async () => ({ agenda: false })),
});

test("só run proativo ligado a um item do dono é run de agenda; chat, rotina e item de outro dono não", async () => {
	const rows = [item()];
	const ctx = (over: { userId?: string; runId?: string; origin?: string }) => loadAgendaRunContext({ userId: "user-a", runId: "run-1", origin: "proactive", objective: "x", now: () => NOW, db: db(rows), ...over });
	assert.ok(await ctx({}));
	assert.equal(await ctx({ origin: "chat" }), null);
	assert.equal(await ctx({ origin: "routine" }), null);
	assert.equal(await ctx({ userId: "user-b" }), null);
	assert.equal(await ctx({ runId: "run-sem-item" }), null);
});

test("monta o que o modelo lê (memo do run anterior, fuso, nota) e a política sem dono com a permissão da criação", async () => {
	const out = await loadAgendaRunContext({ userId: "user-a", runId: "run-1", origin: "proactive", objective: "Agenda wake (watch): n", now: () => NOW, db: db([item()]) });
	assert.ok(out);
	assert.deepEqual(out.policy, { surface: "agenda", ownerPresent: false, autonomy: "always_ask", rules: [] });
	const text = out.history.map((m) => m.text).join("\n");
	assert.match(text, /Run 3 of 10/);
	assert.match(text, /Memo from the last run \(2026-11-05 06:00\): R\$ 4\.990/);
	assert.match(text, /Your note: Ver o preço do notebook X/);
	assert.equal(out.history.length, 1);
});

test("evento do objetivo entra como dado de terceiro", async () => {
	const objective = agendaObjective({ kind: "intent", note: "n" }, { source: "email", from: "banco@exemplo.test", subject: "Fatura", hasAttachment: false });
	const out = await loadAgendaRunContext({ userId: "user-a", runId: "run-1", origin: "proactive", objective, now: () => NOW, db: db([item({ kind: "intent" })]) });
	assert.equal(out?.history.length, 2);
	assert.equal(out?.history[1]?.kind, "data");
});

test("fim do run: update vira a mensagem declarada; no_change vira nada", async () => {
	const rows = [item()];
	const ctx = (await loadAgendaRunContext({ userId: "user-a", runId: "run-1", origin: "proactive", objective: "", now: () => NOW, db: db(rows) }))!;
	const close = (finalize: AgendaRunDb["finalize"], text = "texto do modelo") => closeAgendaRun({ userId: "user-a", runId: "run-1", text, language: "pt-BR", context: ctx, db: db(rows, finalize) });
	assert.equal(await close(async () => ({ agenda: true, itemId: "i1", text: "Caiu para R$ 4.200.", stoppedWithoutResult: false, note: "n" })), "Caiu para R$ 4.200.");
	assert.equal(await close(async () => ({ agenda: true, itemId: "i1", text: "", stoppedWithoutResult: false, note: "n" })), "");
	assert.equal(await close(async () => ({ agenda: false })), "");
});

test("encerrou por falta de resultado: o dono recebe UM aviso, no idioma do bot e sem nome interno", async () => {
	const ctx = (await loadAgendaRunContext({ userId: "user-a", runId: "run-1", origin: "proactive", objective: "", now: () => NOW, db: db([item()]) }))!;
	const finalize: AgendaRunDb["finalize"] = async () => ({ agenda: true, itemId: "i1", text: "", stoppedWithoutResult: true, note: "Ver o preço do notebook X" });
	const pt = await closeAgendaRun({ userId: "user-a", runId: "run-1", text: "", language: "pt-BR", context: ctx, db: db([item()], finalize) });
	assert.equal(pt, 'Parei de acompanhar "Ver o preço do notebook X": não consegui conferir três vezes seguidas. Me peça de novo se ainda quiser.');
	const en = await closeAgendaRun({ userId: "user-a", runId: "run-1", text: "", language: "en-US", context: ctx, db: db([item()], finalize) });
	assert.match(en, /^I stopped following/);
	assert.doesNotMatch(pt, /agenda_result|no_result|run/);
});

test("falha ao fechar: lembrete não se perde (o texto sai), vigia fica calado", async () => {
	const boom: AgendaRunDb["finalize"] = async () => {
		throw new Error("db fora do ar");
	};
	const remind = item({ kind: "remind" });
	const rctx = (await loadAgendaRunContext({ userId: "user-a", runId: "run-1", origin: "proactive", objective: "", now: () => NOW, db: db([remind]) }))!;
	const wctx = (await loadAgendaRunContext({ userId: "user-a", runId: "run-1", origin: "proactive", objective: "", now: () => NOW, db: db([item()]) }))!;
	const originalError = console.error;
	console.error = () => undefined;
	try {
		assert.equal(await closeAgendaRun({ userId: "user-a", runId: "run-1", text: "Hora de ligar.", language: "pt-BR", context: rctx, db: db([remind], boom) }), "Hora de ligar.");
		assert.equal(await closeAgendaRun({ userId: "user-a", runId: "run-1", text: "talvez algo", language: "pt-BR", context: wctx, db: db([item()], boom) }), "");
	} finally {
		console.error = originalError;
	}
});
