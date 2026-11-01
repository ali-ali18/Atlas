/**
 * Oferta "Continuar pesquisa (+US$ X)" no fim do run.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/budget-continue-offer.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBudgetContinueCard, type BudgetContinueEvent, type RunStop } from "@workspace/shared";
import { continuationBudgetUsd, offerContinueAfterBudgetStop, type BudgetContinueOfferIo } from "./budget-continue-offer.js";

function setup(over: Partial<BudgetContinueOfferIo> = {}) {
	const offered: Array<Record<string, unknown>> = [];
	const events: BudgetContinueEvent[] = [];
	const io: BudgetContinueOfferIo = {
		offer: async (input) => {
			offered.push(input);
			return buildBudgetContinueCard({ runId: input.runId, budgetUsd: input.budgetUsd });
		},
		emit: async (event) => void events.push(event),
		...over,
	};
	return { offered, events, io };
}

const base = {
	choice: { engine: "v2" as const, profile: "long_work" as const, longWorkBudgetUsd: 1 },
	run: { id: "run-1", origin: "chat", conversationId: "conv-1" },
	userId: "user-a",
	stop: { reason: "budget_cost", detail: "delivered" } as RunStop,
	effectiveCostCap: undefined,
};

test("estouro de custo ou tempo em trabalho longo oferece continuar com o orçamento do bot", async () => {
	const { offered, events, io } = setup();
	assert.equal(await offerContinueAfterBudgetStop(base, io), true);
	assert.deepEqual(offered, [{ userId: "user-a", conversationId: "conv-1", runId: "run-1", budgetUsd: 1 }]);
	assert.deepEqual(events, [{ type: "budget-continue", offerId: "continue-run-1", runId: "run-1", budgetUsd: 1, status: "pending" }]);
	const wall = setup();
	assert.equal(await offerContinueAfterBudgetStop({ ...base, stop: { reason: "budget_wall" } }, wall.io), true);
});

test("não oferece em chat curto, v1, rotina, sem conversa nem quando terminou normalmente", async () => {
	for (const over of [
		{ choice: { ...base.choice, profile: "chat" as const } },
		{ choice: { ...base.choice, engine: "v1" as const } },
		{ run: { ...base.run, origin: "routine" } },
		{ run: { ...base.run, conversationId: null } },
		{ stop: { reason: "answered" } as RunStop },
		{ stop: { reason: "budget_steps" } as RunStop },
	]) {
		const { offered, events, io } = setup();
		assert.equal(await offerContinueAfterBudgetStop({ ...base, ...over }, io), false);
		assert.deepEqual([offered.length, events.length], [0, 0]);
	}
});

test("o valor mostrado respeita o teto que valeu no run e falha ao gravar não derruba o fim do run", async () => {
	assert.equal(continuationBudgetUsd({ longWorkBudgetUsd: 1 }, undefined), 1);
	assert.equal(continuationBudgetUsd({ longWorkBudgetUsd: 1 }, 0.5), 0.5);
	assert.equal(continuationBudgetUsd({}, undefined), 0.5);
	const failing = setup({ offer: async () => { throw new Error("db fora do ar"); } });
	assert.equal(await offerContinueAfterBudgetStop(base, failing.io), false);
	assert.equal(failing.events.length, 0);
	const duplicate = setup({ offer: async () => null });
	assert.equal(await offerContinueAfterBudgetStop(base, duplicate.io), false);
	assert.equal(duplicate.events.length, 0);
});
