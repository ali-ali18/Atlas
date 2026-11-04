import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConversationCard } from "@workspace/shared";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { closeReturnCard, persistConversationCardFromEvent } from "./conversations.js";

/** PR8d: prazo, desfecho e marcador "Volto às" sobrevivem ao reload (antes só vinham pelo SSE). */
const DEADLINE = "2026-11-04T17:30:00.000Z";
const cardAt = (messages: FakeTable, index = 0) => parseConversationCard(String(messages.rows[index]?.content));

test("cartão de aprovação do v3 grava o prazo, o tipo e o progresso do limite", async () => {
	const messages = new FakeTable([], () => ({ createdAt: new Date() }));
	const installed = installFakes({ conversationMessage: messages, conversation: new FakeTable([{ id: "c1" }]) });
	try {
		await persistConversationCardFromEvent("c1", { type: "confirm", confirmId: "confirm-toolab-r1", title: "Enviar esta mensagem?", confirmLabel: "Permitir", cancelLabel: "Agora não", deadlineAt: DEADLINE, ownerCard: "approval" });
		await persistConversationCardFromEvent("c1", { type: "confirm", confirmId: "confirm-limit1-r2", title: "Cheguei no limite de 40 passos. Continuo?", ownerCard: "step-limit", limitProgress: { steps: 40, tasksDone: ["Ler"], tasksTotal: 3 } });
		assert.deepEqual(
			{ deadlineAt: (cardAt(messages) as { deadlineAt?: string }).deadlineAt, ownerCard: (cardAt(messages) as { ownerCard?: string }).ownerCard },
			{ deadlineAt: DEADLINE, ownerCard: "approval" },
		);
		const limit = cardAt(messages, 1);
		assert.equal(limit?.kind, "confirm");
		if (limit?.kind === "confirm") assert.deepEqual(limit.limitProgress, { steps: 40, tasksDone: ["Ler"], tasksTotal: 3 });
	} finally {
		installed.restore();
	}
});

test("login do v3: prazo no pendente e a saída (Pular) no concluído", async () => {
	const messages = new FakeTable([], () => ({ createdAt: new Date() }));
	const installed = installFakes({ conversationMessage: messages, conversation: new FakeTable([{ id: "c1" }]) });
	try {
		await persistConversationCardFromEvent("c1", { type: "login", loginId: "l1", site: "gemini.google.com", url: "https://gemini.google.com", status: "pending", deadlineAt: DEADLINE, ownerWait: true });
		await persistConversationCardFromEvent("c1", { type: "login", loginId: "l1", site: "gemini.google.com", url: "https://gemini.google.com", status: "done", outcome: "skipped" });
		assert.equal(messages.rows.length, 1);
		const card = cardAt(messages);
		assert.equal(card?.kind, "login");
		if (card?.kind === "login") assert.deepEqual({ status: card.status, outcome: card.outcome, deadlineAt: card.deadlineAt, ownerWait: card.ownerWait }, { status: "done", outcome: "skipped", deadlineAt: DEADLINE, ownerWait: true });
	} finally {
		installed.restore();
	}
});

test("questionário do v3 grava prazo e o Pular", async () => {
	const messages = new FakeTable([], () => ({ createdAt: new Date() }));
	const installed = installFakes({ conversationMessage: messages, conversation: new FakeTable([{ id: "c1" }]) });
	try {
		await persistConversationCardFromEvent("c1", { type: "questionnaire", questionnaireId: "questionnaire-r1", title: "Qual período?", items: [{ name: "p", prompt: "Qual?", choices: [{ value: "a" }] }], status: "pending", deadlineAt: DEADLINE, ownerWait: true });
		const card = cardAt(messages);
		assert.equal(card?.kind, "questionnaire");
		if (card?.kind === "questionnaire") assert.deepEqual({ deadlineAt: card.deadlineAt, ownerWait: card.ownerWait }, { deadlineAt: DEADLINE, ownerWait: true });
	} finally {
		installed.restore();
	}
});

test("Volto às: um marcador por retorno; cancelado muda no lugar e não reabre", async () => {
	const messages = new FakeTable([], () => ({ createdAt: new Date() }));
	const installed = installFakes({ conversationMessage: messages, conversation: new FakeTable([{ id: "c1", userId: "u1" }]) });
	try {
		const event = { type: "return_scheduled" as const, returnId: "ret1", at: DEADLINE, label: "Volto às 14:30", reason: "ver o deploy", status: "pending" as const };
		await persistConversationCardFromEvent("c1", event);
		await persistConversationCardFromEvent("c1", event);
		assert.equal(messages.rows.length, 1);
		assert.equal(messages.rows[0]?.role, "return");
		await persistConversationCardFromEvent("c1", { ...event, status: "cancelled", label: "Retorno cancelado" });
		await persistConversationCardFromEvent("c1", event);
		assert.equal(messages.rows.length, 1);
		assert.deepEqual(cardAt(messages), { v: 1, kind: "return", returnId: "ret1", at: DEADLINE, reason: "ver o deploy", status: "cancelled" });
	} finally {
		installed.restore();
	}
});

test("closeReturnCard: só o dono fecha, e só o pendente", async () => {
	const messages = new FakeTable([], () => ({ createdAt: new Date() }));
	const installed = installFakes({ conversationMessage: messages, conversation: new FakeTable([{ id: "c1", userId: "u1" }]) });
	try {
		await persistConversationCardFromEvent("c1", { type: "return_scheduled", returnId: "ret1", at: DEADLINE, label: "Volto às 14:30", reason: "ver", status: "pending" });
		assert.equal(await closeReturnCard({ conversationId: "c1", ownerId: "u2", returnId: "ret1", status: "cancelled" }), false);
		assert.equal((cardAt(messages) as { status?: string }).status, "pending");
		assert.equal(await closeReturnCard({ conversationId: "c1", ownerId: "u1", returnId: "ret1", status: "done" }), true);
		assert.equal(await closeReturnCard({ conversationId: "c1", ownerId: "u1", returnId: "ret1", status: "cancelled" }), false);
		assert.equal((cardAt(messages) as { status?: string }).status, "done");
	} finally {
		installed.restore();
	}
});
