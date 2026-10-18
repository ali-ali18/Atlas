import assert from "node:assert/strict";
import { test } from "node:test";
import type { DueDelivery } from "@workspace/shared";
import { sweepDeliveryBacklog, type BacklogDeps } from "./backlog.js";
import { buildDeliveryDigest } from "./digest.js";
import { createAwayNoteHandler, settleRunDelivery } from "./run-hooks.js";

const item = (id: string, userId: string, over: Partial<DueDelivery> = {}): DueDelivery => ({
	id,
	userId,
	conversationId: `c-${id}`,
	botName: "Atlas",
	outcome: "completed",
	summary: `resumo ${id}`,
	...over,
});

function harness(due: DueDelivery[], over: Partial<BacklogDeps> = {}) {
	const sent: Array<{ to: string; subject: string; text: string }> = [];
	const finished: Array<{ ids: string[]; ok: boolean }> = [];
	const deps: BacklogDeps = {
		settleSeen: async () => 0,
		recoverStuck: async () => 0,
		claimDue: async () => due,
		emailOf: async (userId) => `${userId}@example.test`,
		send: async (mail) => void sent.push(mail),
		finish: async (ids, ok) => void finished.push({ ids, ok }),
		...over,
	};
	return { deps, sent, finished };
}

test("duas conclusões do mesmo usuário viram um único e-mail; outro usuário recebe o seu", async () => {
	const { deps, sent, finished } = harness([
		item("1", "A"),
		item("2", "A", { outcome: "failed", summary: "sem acesso" }),
		item("3", "B"),
	]);
	const result = await sweepDeliveryBacklog(deps);
	assert.deepEqual(result, { sent: 2, failed: 0 });
	assert.equal(sent.length, 2);
	const toA = sent.find((mail) => mail.to === "A@example.test")!;
	assert.match(toA.subject, /2 resultados/);
	assert.match(toA.text, /resumo 1/);
	assert.match(toA.text, /não consegui concluir\. sem acesso/, "falha segue no lote com texto honesto");
	assert.doesNotMatch(toA.text, /resumo 3/, "nunca mistura donos");
	assert.deepEqual(finished, [
		{ ids: ["1", "2"], ok: true },
		{ ids: ["3"], ok: true },
	]);
});

test("sem entregas vencidas não envia nada; segunda varredura não repete", async () => {
	const queue = [item("1", "A")];
	const { deps, sent } = harness([], { claimDue: async () => queue.splice(0) });
	await sweepDeliveryBacklog(deps);
	await sweepDeliveryBacklog(deps);
	assert.equal(sent.length, 1);
});

test("falha de envio ou usuário sem e-mail devolve à fila sem lançar", async () => {
	const boom = harness([item("1", "A")], {
		send: async () => {
			throw new Error("smtp fora");
		},
	});
	assert.deepEqual(await sweepDeliveryBacklog(boom.deps), { sent: 0, failed: 1 });
	assert.deepEqual(boom.finished, [{ ids: ["1"], ok: false }]);
	const none = harness([item("2", "B")], { emailOf: async () => null });
	assert.deepEqual(await sweepDeliveryBacklog(none.deps), { sent: 0, failed: 1 });
	assert.equal(none.sent.length, 0);
});

test("digest escapa HTML e distingue limite de trabalho", () => {
	const mail = buildDeliveryDigest({
		userId: "A",
		items: [item("1", "A", { outcome: "budget_exhausted", summary: "<b>x</b>" })],
	});
	assert.match(mail.html, /&lt;b&gt;x&lt;\/b&gt;/);
	assert.match(mail.text, /limite de trabalho/);
	assert.equal(mail.subject, "Seu resultado está pronto");
});

test("nota de ausência: horário combinado vira data; vazio vira entrega ao fim do run; sem conversa não registra", async () => {
	const calls: Array<{ deliverAfter: Date | null; userId: string }> = [];
	const now = () => new Date("2026-10-11T02:30:00.000Z");
	const handler = createAwayNoteHandler({
		userId: "A",
		runId: "r1",
		conversationId: "c1",
		record: async (input) => (calls.push(input), true),
		now,
	})!;
	await handler({ deliverAt: "2026-10-11T07:00" });
	await handler({ deliverAt: "" });
	assert.equal(calls[0]!.deliverAfter?.toISOString(), "2026-10-11T10:00:00.000Z");
	assert.equal(calls[1]!.deliverAfter, null);
	assert.equal(calls[0]!.userId, "A");
	assert.equal(createAwayNoteHandler({ userId: "A", runId: "r1", conversationId: null, record: async () => true }), undefined);
});

test("fim do run: concluído/falho entram no backlog, cancelado é descartado, erro do db não lança", async () => {
	const ready: unknown[] = [];
	const cancelled: unknown[] = [];
	const deps = {
		markReady: async (input: unknown) => (ready.push(input), true),
		cancel: async (input: unknown) => void cancelled.push(input),
	};
	await settleRunDelivery({ userId: "A", runId: "r1", end: "completed", resultText: "feito\n  tudo" }, deps);
	await settleRunDelivery({ userId: "A", runId: "r2", end: "failed", resultText: "erro" }, deps);
	await settleRunDelivery({ userId: "A", runId: "r3", end: "cancelled" }, deps);
	assert.deepEqual(ready, [
		{ userId: "A", runId: "r1", outcome: "completed", summary: "feito tudo" },
		{ userId: "A", runId: "r2", outcome: "failed", summary: "erro" },
	]);
	assert.equal(cancelled.length, 1);
	await settleRunDelivery(
		{ userId: "A", runId: "r4", end: "completed" },
		{
			...deps,
			markReady: async () => {
				throw new Error("db");
			},
		},
	);
});
