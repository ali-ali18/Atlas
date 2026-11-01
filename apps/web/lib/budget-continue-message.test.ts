import assert from "node:assert/strict";
import test from "node:test";
import type { BudgetContinueEvent } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import { budgetContinueMessageFromEvent, collapseBudgetContinueCards, setBudgetContinueState } from "./budget-continue-message";
import { dedupeCards } from "./thread-merge";

const event: BudgetContinueEvent = { type: "budget-continue", offerId: "continue-run-1", runId: "run-1", budgetUsd: 1 };
type Card = Extract<Message, { kind: "budget-continue" }>;

test("evento vira card pendente com id estável por oferta", () => {
	const card = budgetContinueMessageFromEvent(event);
	assert.equal(card.id, "budget-continue-continue-run-1");
	assert.equal(card.offer.status, "pending");
	assert.equal(card.offer.budgetUsd, 1);
});

test("estado: aplicando, aprovado (com o run de continuação) e erro", () => {
	const base: Message[] = [budgetContinueMessageFromEvent(event), { id: "x", kind: "assistant", text: "oi" }];
	assert.equal((setBudgetContinueState(base, "continue-run-1", "applying")[0] as Card).isApplying, true);
	const done = setBudgetContinueState(base, "continue-run-1", { status: "approved", continuationRunId: "run-2" })[0] as Card;
	assert.equal(done.offer.status, "approved");
	assert.equal(done.offer.continuationRunId, "run-2");
	assert.equal(done.isApplying, false);
	assert.equal((setBudgetContinueState(base, "continue-run-1", { error: "falhou" })[0] as Card).error, "falhou");
	assert.deepEqual(setBudgetContinueState(base, "outra-oferta", "applying"), base);
});

test("o card ao vivo e o persistido da mesma oferta viram um só (fica o persistido, com o estado decidido)", () => {
	const live = budgetContinueMessageFromEvent(event);
	const persisted: Message = { id: "db-1", kind: "budget-continue", offer: { offerId: "continue-run-1", runId: "run-1", budgetUsd: 1, status: "approved", continuationRunId: "run-2" } };
	for (const order of [[live, persisted], [persisted, live]]) {
		const merged = collapseBudgetContinueCards(order);
		assert.equal(merged.length, 1);
		assert.equal(merged[0]!.id, "db-1");
		assert.equal((merged[0] as Card).offer.status, "approved");
	}
	const pendingPersisted: Message = { ...persisted, offer: { ...persisted.offer, status: "pending" } };
	assert.equal((collapseBudgetContinueCards([pendingPersisted, { ...live, offer: { ...live.offer, status: "dismissed" } }])[0] as Card).offer.status, "dismissed");
});

test("dedupe da thread não mostra o card duas vezes", () => {
	const live = budgetContinueMessageFromEvent(event);
	const persisted: Message = { id: "db-1", kind: "budget-continue", offer: live.offer };
	assert.equal(dedupeCards([live, persisted]).filter((item) => item.kind === "budget-continue").length, 1);
});
