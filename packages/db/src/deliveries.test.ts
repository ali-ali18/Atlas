/**
 * F5: backlog de entrega offline com tabelas em memória.
 * Runner: `pnpm exec tsx --test src/deliveries.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { DELIVERY_COALESCE_WINDOW_MS } from "@workspace/shared";
import {
	cancelRunDelivery,
	claimDueDeliveries,
	finishDeliveries,
	markConversationResultsSeen,
	markDeliveryReady,
	recordAwayNote,
	recoverStuckDeliveries,
	settleSeenDeliveries,
	unreadResultsByConversation,
} from "./deliveries.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let runs: FakeTable;
let deliveries: FakeTable;
let bots: FakeTable;
let installed: { restore: () => void };

const T0 = new Date("2026-10-11T03:00:00.000Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(() => {
	runs = new FakeTable([
		{ id: "run-a1", userId: "A", conversationId: "conv-a1" },
		{ id: "run-a2", userId: "A", conversationId: "conv-a1" },
		{ id: "run-b1", userId: "B", conversationId: "conv-b1" },
	]);
	deliveries = new FakeTable([], () => ({
		outcome: null,
		summary: null,
		deliverAfter: null,
		dueAt: null,
		attempts: 0,
		seenAt: null,
		notifiedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	}));
	bots = new FakeTable([{ id: "bot-a", conversationId: "conv-a1", ownerId: "A", name: "Bot A" }]);
	installed = installFakes({ agentRun: runs, runDelivery: deliveries, bot: bots });
});
afterEach(() => installed.restore());

test("nota de ausência só vale para run do próprio usuário", async () => {
	assert.equal(await recordAwayNote({ userId: "B", runId: "run-a1", conversationId: "conv-a1" }), false);
	assert.equal(deliveries.rows.length, 0);
	assert.equal(await recordAwayNote({ userId: "A", runId: "run-a1", conversationId: "conv-a1" }), true);
	assert.equal(deliveries.rows.length, 1);
	// Repetir a nota não duplica a linha.
	await recordAwayNote({ userId: "A", runId: "run-a1", conversationId: "conv-a1" });
	assert.equal(deliveries.rows.length, 1);
});

test("run sem nota de ausência não entra no backlog", async () => {
	assert.equal(await markDeliveryReady({ userId: "A", runId: "run-a1", outcome: "completed", summary: "ok", now: T0 }), false);
});

test("usuário B não marca como pronta nem cancela a entrega do A", async () => {
	await recordAwayNote({ userId: "A", runId: "run-a1", conversationId: "conv-a1" });
	assert.equal(await markDeliveryReady({ userId: "B", runId: "run-a1", outcome: "completed", summary: "x", now: T0 }), false);
	await cancelRunDelivery({ userId: "B", runId: "run-a1" });
	assert.equal(deliveries.rows[0]!.status, "waiting");
});

test("pronta: vence depois da janela de coalescência, ou no horário combinado", async () => {
	await recordAwayNote({ userId: "A", runId: "run-a1", conversationId: "conv-a1" });
	await recordAwayNote({ userId: "A", runId: "run-a2", conversationId: "conv-a1", deliverAfter: after(6 * 3600_000) });
	await markDeliveryReady({ userId: "A", runId: "run-a1", outcome: "completed", summary: "um", now: T0 });
	await markDeliveryReady({ userId: "A", runId: "run-a2", outcome: "failed", summary: "dois", now: T0 });
	const [first, second] = deliveries.rows;
	assert.equal((first!.dueAt as Date).getTime(), T0.getTime() + DELIVERY_COALESCE_WINDOW_MS);
	assert.equal((second!.dueAt as Date).getTime(), after(6 * 3600_000).getTime());
});

test("duas conclusões na mesma janela saem juntas; uma entrega agendada espera o horário", async () => {
	await recordAwayNote({ userId: "A", runId: "run-a1", conversationId: "conv-a1" });
	await recordAwayNote({ userId: "A", runId: "run-a2", conversationId: "conv-a1" });
	await markDeliveryReady({ userId: "A", runId: "run-a1", outcome: "completed", summary: "um", now: T0 });
	await markDeliveryReady({ userId: "A", runId: "run-a2", outcome: "failed", summary: "dois", now: after(30_000) });
	assert.equal((await claimDueDeliveries(after(60_000))).length, 0, "ainda dentro da janela");
	const due = await claimDueDeliveries(after(DELIVERY_COALESCE_WINDOW_MS + 60_000));
	assert.deepEqual(due.map((item) => item.summary).sort(), ["dois", "um"]);
	assert.ok(due.every((item) => item.userId === "A" && item.botName === "Bot A"));
});

test("não duplica: o que já foi reivindicado ou enviado não volta", async () => {
	await recordAwayNote({ userId: "A", runId: "run-a1", conversationId: "conv-a1" });
	await markDeliveryReady({ userId: "A", runId: "run-a1", outcome: "completed", summary: "um", now: T0 });
	const later = after(DELIVERY_COALESCE_WINDOW_MS + 1);
	const first = await claimDueDeliveries(later);
	assert.equal(first.length, 1);
	assert.equal((await claimDueDeliveries(later)).length, 0, "reivindicada, outro sweeper não pega");
	await finishDeliveries(first.map((item) => item.id), true, later);
	assert.equal((await claimDueDeliveries(after(10 * 3600_000))).length, 0);
	assert.equal(deliveries.rows[0]!.status, "sent");
});

test("visto antes da hora: a notificação é dispensada", async () => {
	await recordAwayNote({ userId: "A", runId: "run-a1", conversationId: "conv-a1" });
	await markDeliveryReady({ userId: "A", runId: "run-a1", outcome: "completed", summary: "um", now: T0 });
	assert.equal(await markConversationResultsSeen({ userId: "A", conversationId: "conv-a1", now: after(1000) }), 1);
	assert.equal((await claimDueDeliveries(after(DELIVERY_COALESCE_WINDOW_MS + 1))).length, 0);
	await settleSeenDeliveries();
	assert.equal(deliveries.rows[0]!.status, "cancelled");
});

test("badge de resultados novos é por usuário e some ao abrir a conversa", async () => {
	await recordAwayNote({ userId: "A", runId: "run-a1", conversationId: "conv-a1" });
	await recordAwayNote({ userId: "B", runId: "run-b1", conversationId: "conv-b1" });
	await markDeliveryReady({ userId: "A", runId: "run-a1", outcome: "completed", summary: "a", now: T0 });
	await markDeliveryReady({ userId: "B", runId: "run-b1", outcome: "completed", summary: "b", now: T0 });
	assert.deepEqual([...(await unreadResultsByConversation("A"))], [["conv-a1", 1]]);
	assert.deepEqual([...(await unreadResultsByConversation("B"))], [["conv-b1", 1]]);
	// B abrindo a conversa do A não limpa o badge do A.
	assert.equal(await markConversationResultsSeen({ userId: "B", conversationId: "conv-a1" }), 0);
	assert.equal((await unreadResultsByConversation("A")).size, 1);
	await markConversationResultsSeen({ userId: "A", conversationId: "conv-a1" });
	assert.equal((await unreadResultsByConversation("A")).size, 0);
});

test("falha de envio volta para a fila e desiste depois de 5 tentativas; sending preso é recuperado", async () => {
	await recordAwayNote({ userId: "A", runId: "run-a1", conversationId: "conv-a1" });
	await markDeliveryReady({ userId: "A", runId: "run-a1", outcome: "completed", summary: "um", now: T0 });
	const later = after(DELIVERY_COALESCE_WINDOW_MS + 1);
	for (let attempt = 1; attempt <= 5; attempt++) {
		const claimed = await claimDueDeliveries(later);
		assert.equal(claimed.length, 1, `tentativa ${attempt}`);
		await finishDeliveries(claimed.map((item) => item.id), false);
	}
	assert.equal(deliveries.rows[0]!.status, "failed");
	assert.equal((await claimDueDeliveries(later)).length, 0);

	deliveries.rows[0]!.status = "sending";
	deliveries.rows[0]!.updatedAt = new Date(T0.getTime() - 3600_000);
	assert.equal(await recoverStuckDeliveries(T0), 1);
	assert.equal(deliveries.rows[0]!.status, "ready");
});
