import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { settleStepLimitCard, STEP_LIMIT_CARD_DETAIL } = await import("./step-limit-card.js");
type Deps = Parameters<typeof settleStepLimitCard>[1] & object;
type Pending = Parameters<typeof settleStepLimitCard>[0]["pending"];

const USER = "user-a";
const CONV = "conv-1";
const RUN = "run-routine-1";
const CARD = `confirm-limit1-${RUN}`;

const pending = (over: Partial<Pending["payload"]> = {}): Pending => ({
	id: "p1",
	userId: USER,
	conversationId: CONV,
	kind: "confirm",
	payload: { kind: "confirm", action: "step-limit", confirmId: CARD, stepLimit: { runId: RUN }, ...over },
	expiresAt: new Date(Date.now() + 60_000),
});

/** Banco em memória: a intenção (uma vez só), a decisão no checkpoint (só do dono e deste cartão) e o run pausado. */
function fakeDeps(input: { owner?: string; claimed?: boolean } = {}) {
	const calls = { marked: [] as Array<{ outcome: string; cardId?: string; userId: string }>, cards: [] as Array<{ status: string; ok: boolean }>, resumed: [] as string[] };
	let claimed = input.claimed ?? false;
	const deps: Deps = {
		claim: (async () => {
			if (claimed) return false;
			claimed = true;
			return true;
		}) as Deps["claim"],
		markOutcome: (async (args: { runId: string; userId: string; outcome: "continue" | "stop"; cardId?: string }) => {
			if (args.userId !== (input.owner ?? USER) || args.runId !== RUN || args.cardId !== CARD) return false;
			calls.marked.push({ outcome: args.outcome, userId: args.userId, ...(args.cardId ? { cardId: args.cardId } : {}) });
			return true;
		}) as Deps["markOutcome"],
		updateCard: (async (_conv: string, status: string, _id?: string, _user?: string, outcome?: { ok: boolean }) => {
			calls.cards.push({ status, ok: outcome?.ok ?? false });
		}) as Deps["updateCard"],
		resume: (async (runId: string) => {
			calls.resumed.push(runId);
			return { id: runId, status: "queued" } as Awaited<ReturnType<Deps["resume"]>>;
		}) as Deps["resume"],
	};
	return { deps, calls };
}

test("Continuar: grava a decisão no checkpoint ANTES de liberar o mesmo run, e o cartão fica aprovado", async () => {
	const { deps, calls } = fakeDeps();
	const settled = await settleStepLimitCard({ userId: USER, conversationId: CONV, pending: pending(), decision: "continue" }, deps);
	assert.ok("run" in settled);
	assert.equal(settled.run.id, RUN);
	assert.deepEqual(calls.marked, [{ outcome: "continue", userId: USER, cardId: CARD }]);
	assert.deepEqual(calls.cards, [{ status: "approved", ok: true }]);
	assert.deepEqual(calls.resumed, [RUN]);
	assert.equal(STEP_LIMIT_CARD_DETAIL.continue, "o dono pediu para continuar");
});

test("Agora não: grava stop e libera o run só para a resposta final (o cartão fica recusado)", async () => {
	const { deps, calls } = fakeDeps();
	const settled = await settleStepLimitCard({ userId: USER, conversationId: CONV, pending: pending(), decision: "stop" }, deps);
	assert.ok("run" in settled);
	assert.equal(calls.marked[0]?.outcome, "stop");
	assert.deepEqual(calls.cards, [{ status: "rejected", ok: false }]);
});

test("clique repetido: a segunda reserva falha e nada muda (nem checkpoint, nem run)", async () => {
	const { deps, calls } = fakeDeps({ claimed: true });
	const settled = await settleStepLimitCard({ userId: USER, conversationId: CONV, pending: pending(), decision: "continue" }, deps);
	assert.deepEqual(settled, { duplicate: true });
	assert.equal(calls.marked.length, 0);
	assert.equal(calls.resumed.length, 0);
});

test("run de outro dono (ou que já não espera este cartão): não libera nada", async () => {
	const { deps, calls } = fakeDeps({ owner: "user-b" });
	const settled = await settleStepLimitCard({ userId: USER, conversationId: CONV, pending: pending(), decision: "continue" }, deps);
	assert.deepEqual(settled, { duplicate: true });
	assert.equal(calls.resumed.length, 0);
});

test("intenção sem run ou sem cartão: não toca em nada", async () => {
	const { deps, calls } = fakeDeps();
	assert.deepEqual(await settleStepLimitCard({ userId: USER, conversationId: CONV, pending: pending({ stepLimit: undefined }), decision: "continue" }, deps), { duplicate: true });
	assert.equal(calls.resumed.length, 0);
});
