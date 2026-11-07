/**
 * Pagamento do v4 no worker (F6.2 a F6.4) com db falso que filtra por dono como o real. Só número de teste público e CVV fictício.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/payment.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCvvEscrow, type CvvScope, type Sandbox } from "@workspace/agent";
import { createV4Payment, type V4PaymentDeps } from "./payment.js";
import { buildV4Registry } from "./index.js";
import { fakeAdapterDeps } from "./index.test.js";

const NOW = new Date("2026-11-07T12:00:00Z");
const CARD = { number: "4111111111111111", holder: "TESTE DA SILVA", expMonth: 12, expYear: 2030, billing: { line1: "Rua Teste 1", city: "Sao Paulo", state: "SP", postalCode: "01000-000", country: "BR" } };
const CVV = "737";

type Row = { id: string; userId: string; label: string; brand: string; last4: string; secretsEnc: string; createdAt: Date };
function fakeDeps(cards: Row[], mandate: { userId: string; maxAmount: number; currency: string; merchants: string[]; until: Date; usesLeft: number } | null = null) {
	const lowered: Array<[string, number]> = [];
	const deps: V4PaymentDeps = {
		listCards: async (userId) => cards.filter((c) => c.userId === userId),
		getMeta: async (userId, id) => cards.find((c) => c.userId === userId && c.id === id) ?? null,
		getSealed: async (userId, id) => cards.find((c) => c.userId === userId && c.id === id) ?? null,
		openJson: (sealed) => sealed.replace("sealed:", ""),
		getMandate: async (userId) => (mandate && mandate.userId === userId ? { id: "m", ...mandate } : null),
		lowerUses: async (userId, left) => void lowered.push([userId, left]),
	};
	return { deps: deps as V4PaymentDeps, lowered };
}
const row = (userId: string, id = "card-1"): Row => ({ id, userId, label: "Visa final 1111", brand: "visa", last4: "1111", secretsEnc: `sealed:${JSON.stringify(CARD)}`, createdAt: NOW });

function memoryEscrow() {
	const map = new Map<string, string>();
	return createCvvEscrow({ set: async (k, v) => void map.set(k, v), getdel: async (k) => { const v = map.get(k) ?? null; map.delete(k); return v; }, del: async (k) => void map.delete(k) }, { seal: (p) => `s:${p}`, open: (s) => (s.startsWith("s:") ? s.slice(2) : null) });
}
const vm = (actions: unknown[]): Sandbox => ({ run: async (_u, a) => (actions.push(a), { ok: true, data: { state: "paid", orderRef: "PED-1" } }), release: async () => undefined });

test("só os cartões do dono do run entram; o modelo recebe bandeira e final, nunca o texto selado", async () => {
	const { deps } = fakeDeps([row("a"), row("b", "card-b")]);
	const p = await createV4Payment({ userId: "a", escrow: memoryEscrow(), sandbox: vm([]), ownerPresent: true, deps, now: () => NOW });
	assert.deepEqual(p.checkout?.cards, [{ id: "card-1", brand: "visa", last4: "1111", label: "Visa final 1111" }]);
	assert.equal(JSON.stringify(p.checkout?.cards).includes("sealed"), false);
});

test("sem cartão, sem canal do CVV ou sem dono na conversa: pagamento não é oferecido", async () => {
	const none = fakeDeps([]);
	assert.equal((await createV4Payment({ userId: "a", escrow: memoryEscrow(), sandbox: vm([]), ownerPresent: true, deps: none.deps })).checkout, undefined);
	const some = fakeDeps([row("a")]);
	assert.equal((await createV4Payment({ userId: "a", escrow: null, sandbox: vm([]), ownerPresent: true, deps: some.deps })).checkout, undefined);
	assert.equal((await createV4Payment({ userId: "a", escrow: memoryEscrow(), sandbox: vm([]), ownerPresent: false, deps: some.deps })).checkout, undefined);
});

test("falha ao ler o cofre não derruba o run e o log não leva dado de cartão", async () => {
	const { deps } = fakeDeps([row("a")]);
	const logs: string[] = [];
	const failing: V4PaymentDeps = { ...deps, listCards: async () => { throw new Error(`falha ${CARD.number}`); } };
	const p = await createV4Payment({ userId: "a", escrow: memoryEscrow(), sandbox: vm([]), ownerPresent: true, deps: failing, log: (m) => void logs.push(m) });
	assert.equal(p.checkout, undefined);
	assert.equal(logs.join("").includes("4111"), false);
});

test("card_fill de ponta a ponta no worker: cartão do cofre + CVV do canal vão à VM; cartão de outro dono não", async () => {
	const actions: unknown[] = [];
	const escrow = memoryEscrow();
	const { deps } = fakeDeps([row("a")]);
	const a = await createV4Payment({ userId: "a", escrow, sandbox: vm(actions), ownerPresent: true, deps });
	const scope: CvvScope = { userId: "a", runId: "run-1", requestId: "req-1" };
	await escrow.deposit(scope, CVV, 60_000);
	const ok = await a.checkout!.fill.fill({ ...scope, approvalId: "req-1", cardId: "card-1", merchant: "loja.test", checkoutUrl: "https://loja.test/pay", amount: 10, currency: "BRL" });
	assert.equal(ok.status, "paid");
	const params = (actions[0] as { params: { card: { number: string }; cvv: string } }).params;
	assert.equal(params.card.number, CARD.number);
	assert.equal(params.cvv, CVV);
	// B tenta o cartão de A pelo fill do próprio run: não encontra e o CVV de B é descartado
	const b = await createV4Payment({ userId: "b", escrow, sandbox: vm(actions), ownerPresent: true, deps: fakeDeps([row("b", "card-b")]).deps });
	const scopeB: CvvScope = { userId: "b", runId: "run-2", requestId: "req-2" };
	await escrow.deposit(scopeB, CVV, 60_000);
	const denied = await b.checkout!.fill.fill({ ...scopeB, approvalId: "req-2", cardId: "card-1", merchant: "loja.test", checkoutUrl: "https://loja.test/pay", amount: 10, currency: "BRL" });
	assert.equal(denied.status, "no_card");
	assert.equal(actions.length, 1);
	assert.equal(await escrow.take(scopeB), null);
});

test("mandato: só vale com dono presente, usos e prazo; o uso gasto é gravado só para baixo", async () => {
	const until = new Date("2026-12-01T00:00:00Z");
	const m = { userId: "a", maxAmount: 100, currency: "BRL", merchants: ["loja.test"], until, usesLeft: 2 };
	const live = fakeDeps([], m);
	const p = await createV4Payment({ userId: "a", escrow: null, sandbox: vm([]), ownerPresent: true, deps: live.deps, now: () => NOW });
	assert.deepEqual(p.mandate, { maxAmount: 100, currency: "BRL", merchants: ["loja.test"], until: until.toISOString(), usesLeft: 2 });
	await p.onMandateSpent(1);
	assert.deepEqual(live.lowered, [["a", 1]]);
	assert.equal((await createV4Payment({ userId: "b", escrow: null, sandbox: vm([]), ownerPresent: true, deps: live.deps, now: () => NOW })).mandate, undefined);
	assert.equal((await createV4Payment({ userId: "a", escrow: null, sandbox: vm([]), ownerPresent: false, deps: live.deps, now: () => NOW })).mandate, undefined);
	assert.equal((await createV4Payment({ userId: "a", escrow: null, sandbox: vm([]), ownerPresent: true, deps: fakeDeps([], { ...m, usesLeft: 0 }).deps, now: () => NOW })).mandate, undefined);
	assert.equal((await createV4Payment({ userId: "a", escrow: null, sandbox: vm([]), ownerPresent: true, deps: fakeDeps([], { ...m, until: new Date("2026-01-01") }).deps, now: () => NOW })).mandate, undefined);
});

test("o registro do run lista a capacidade de pagamento (lazy) só quando há cartão", async () => {
	const notes = {} as never;
	const base = { runId: "run-1", userId: "a", conversationId: "c", unattended: false, notes, emit: () => undefined, makeHelpers: () => ({ runAll: async () => [] }), botId: "bot-1", deps: fakeAdapterDeps() };
	const { deps } = fakeDeps([row("a")]);
	const p = await createV4Payment({ userId: "a", escrow: memoryEscrow(), sandbox: vm([]), ownerPresent: true, deps });
	const withCard = await buildV4Registry({ ...base, ...(p.checkout && { checkout: p.checkout }) });
	assert.ok(withCard.registry.ids().includes("checkout"));
	assert.ok(withCard.stableSystem.includes("checkout"));
	assert.equal(withCard.stableSystem.includes("Visa"), false);
	const without = await buildV4Registry(base);
	assert.equal(without.registry.ids().includes("checkout"), false);
});
