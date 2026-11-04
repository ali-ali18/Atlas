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

/**
 * Banco em memória com a regra real: a decisão no checkpoint (só do dono e deste cartão; a mesma decisão de novo confere,
 * outra perde), a liberação condicional do run pausado (uma vez só) e a intenção pendente.
 */
function fakeDeps(input: { owner?: string; resumeFailures?: number; markFails?: boolean } = {}) {
	const state = { outcome: undefined as string | undefined, paused: true, intentAlive: true, order: [] as string[], cards: [] as Array<{ status: string; ok: boolean }> };
	let resumeFailures = input.resumeFailures ?? 0;
	const deps: Deps = {
		claim: (async () => {
			state.order.push("claim");
			const was = state.intentAlive;
			state.intentAlive = false;
			return was;
		}) as Deps["claim"],
		markOutcome: (async (args: { runId: string; userId: string; outcome: "continue" | "stop"; cardId?: string }) => {
			state.order.push("mark");
			if (input.markFails) throw new Error("db down");
			if (args.userId !== (input.owner ?? USER) || args.runId !== RUN || args.cardId !== CARD) return false;
			if (state.outcome) return state.outcome === args.outcome;
			state.outcome = args.outcome;
			return true;
		}) as Deps["markOutcome"],
		updateCard: (async (_conv: string, status: string, _id?: string, _user?: string, outcome?: { ok: boolean }) => {
			state.cards.push({ status, ok: outcome?.ok ?? false });
		}) as Deps["updateCard"],
		resume: (async (runId: string) => {
			state.order.push("resume");
			if (resumeFailures > 0) {
				resumeFailures -= 1;
				throw new Error("db down");
			}
			if (!state.paused) return null;
			state.paused = false;
			return { id: runId, status: "queued" } as Awaited<ReturnType<Deps["resume"]>>;
		}) as Deps["resume"],
	};
	return { deps, state };
}

const settle = (deps: Deps, decision: "continue" | "stop" = "continue") => settleStepLimitCard({ userId: USER, conversationId: CONV, pending: pending(), decision }, deps);

test("Continuar: grava a decisão, libera o mesmo run e só então tira a intenção e fecha o cartão", async () => {
	const { deps, state } = fakeDeps();
	const settled = await settle(deps);
	assert.ok("run" in settled);
	assert.equal(settled.run.id, RUN);
	assert.equal(state.outcome, "continue");
	assert.deepEqual(state.order, ["mark", "resume", "claim"]);
	assert.deepEqual(state.cards, [{ status: "approved", ok: true }]);
	assert.equal(STEP_LIMIT_CARD_DETAIL.continue, "o dono pediu para continuar");
});

test("Agora não: grava stop e libera o run só para a resposta final (o cartão fica recusado)", async () => {
	const { deps, state } = fakeDeps();
	assert.ok("run" in (await settle(deps, "stop")));
	assert.equal(state.outcome, "stop");
	assert.deepEqual(state.cards, [{ status: "rejected", ok: false }]);
});

test("liberação que falha não deixa o run pausado para sempre: a intenção continua viva e o clique de novo retoma", async () => {
	const { deps, state } = fakeDeps({ resumeFailures: 1 });
	assert.deepEqual(await settle(deps), { duplicate: true });
	assert.equal(state.intentAlive, true);
	assert.equal(state.paused, true);
	const again = await settle(deps);
	assert.ok("run" in again);
	assert.equal(state.intentAlive, false);
});

test("gravar a decisão falha: nada é liberado nem consumido", async () => {
	const { deps, state } = fakeDeps({ markFails: true });
	assert.deepEqual(await settle(deps), { duplicate: true });
	assert.equal(state.intentAlive, true);
	assert.deepEqual(state.order, ["mark"]);
});

test("dois cliques: o run sai uma vez só; decisão diferente depois da primeira perde", async () => {
	const { deps, state } = fakeDeps();
	const [a, b] = await Promise.all([settle(deps), settle(deps)]);
	assert.equal(["run" in a, "run" in b].filter(Boolean).length, 1);
	assert.deepEqual(await settle(deps, "stop"), { duplicate: true });
	assert.equal(state.outcome, "continue");
});

test("run de outro dono (ou que já não espera este cartão): não libera nada", async () => {
	const { deps, state } = fakeDeps({ owner: "user-b" });
	assert.deepEqual(await settle(deps), { duplicate: true });
	assert.equal(state.paused, true);
	assert.equal(state.intentAlive, true);
});

test("intenção sem run ou sem cartão: não toca em nada", async () => {
	const { deps, state } = fakeDeps();
	assert.deepEqual(await settleStepLimitCard({ userId: USER, conversationId: CONV, pending: pending({ stepLimit: undefined }), decision: "continue" }, deps), { duplicate: true });
	assert.deepEqual(state.order, []);
});
