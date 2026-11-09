/**
 * Adaptador da porta Sandbox (F8.0) com VM/manager falsos: escopo usuário + conversa, `card_fill` de ponta a ponta pela porta
 * `CardFill` do agente, desafio sem repetir o pagamento e varredura de segredo. Sem Docker, rede nem Chrome.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/sandbox.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCardFill, createCvvEscrow, type CardFillInput, type CardVault } from "@workspace/agent";
import { SandboxControlError, type ControlCardFillParams, type ControlCardFillResult, type SandboxManager } from "@workspace/sandbox";
import { createV4Sandbox, realV4SandboxDeps, type V4SandboxDeps } from "./sandbox.js";
import { sealSecretValue } from "@workspace/agent";

const CARD = { number: "4111111111111111", holder: "MARIA SOUZA LIMA", expMonth: 9, expYear: 2031, billing: { line1: "Rua das Flores 123", city: "Sao Paulo", state: "SP", postalCode: "01310-100", country: "BR" } };
const CVV = "737";
const SECRETS = [CARD.number, "4111 1111 1111 1111", CVV, CARD.holder, CARD.billing.line1, CARD.billing.postalCode];

type World = {
	/** sessionId -> dono (o manager real confere a posse; o fake imita). */
	owners: Map<string, string>;
	resolved: Array<{ userId: string; conversationId: string | undefined }>;
	destroyed: string[];
	fills: Array<{ userId: string; sessionId: string; params: ControlCardFillParams }>;
	control: (params: ControlCardFillParams) => Promise<ControlCardFillResult>;
	resolveFails: boolean;
};
function world(control: World["control"] = async () => ({ state: "paid", orderRef: "PED-12345" })): { deps: V4SandboxDeps; w: World } {
	const w: World = { owners: new Map(), resolved: [], destroyed: [], fills: [], control, resolveFails: false };
	const deps: V4SandboxDeps = {
		createManager(userId) {
			const manager = {
				async resolveSession(conversationId?: string) {
					w.resolved.push({ userId, conversationId });
					if (w.resolveFails) throw new Error("Docker unavailable");
					const sessionId = `s-${userId}-${conversationId ?? "none"}`;
					w.owners.set(sessionId, userId);
					return { sessionId, status: "running", viewerUrl: "", createdAt: "" };
				},
				async destroySession(sessionId: string) {
					if (w.owners.get(sessionId) !== userId) return false;
					w.destroyed.push(sessionId);
					return true;
				},
				async execCardFill(sessionId: string, params: ControlCardFillParams) {
					if (w.owners.get(sessionId) !== userId) throw new Error("Sandbox session not found");
					w.fills.push({ userId, sessionId, params });
					return w.control(params);
				},
			};
			return manager as unknown as SandboxManager;
		},
	};
	return { deps, w };
}

const scope = (userId = "user-a", conversationId: string | null = "conv-1", runId = "run-1") => ({ userId, runId, conversationId });
const action = (overrides: Record<string, unknown> = {}) => ({ kind: "card_fill", params: { url: "https://loja.exemplo.com/checkout", card: CARD, cvv: CVV, merchant: "loja.exemplo.com", amount: 129.9, currency: "BRL", ...overrides } });

function fillPort(sandbox: ReturnType<typeof createV4Sandbox>, userId = "user-a") {
	const vault: CardVault = { describe: async () => null, open: async (u, id) => (u === userId && id === "card-1" ? { info: { id, brand: "visa", last4: "1111", label: "Visa" }, secrets: sealSecretValue(JSON.stringify(CARD)) } : null) };
	const store = new Map<string, string>();
	const escrow = createCvvEscrow({ set: async (k, v) => (store.set(k, v), true), getdel: async (k) => { const v = store.get(k) ?? null; store.delete(k); return v; }, del: async (k) => void store.delete(k) }, { seal: (p) => `s:${p}`, open: (s) => s.slice(2) });
	const input: CardFillInput = { userId, runId: "run-1", approvalId: "ap-1", cardId: "card-1", merchant: "loja.exemplo.com", checkoutUrl: "https://loja.exemplo.com/checkout", amount: 129.9, currency: "BRL" };
	const deposit = () => escrow.deposit({ userId, runId: "run-1", requestId: "ap-1" }, CVV, 60_000);
	return { fill: createCardFill({ vault, escrow, sandbox }), input, deposit };
}

test("mapeia o run para usuário + conversa e reaproveita a mesma VM nas ações seguintes", async () => {
	const { deps, w } = world();
	const sandbox = createV4Sandbox({ scope: scope(), deps });
	await sandbox.run("user-a", action());
	await sandbox.run("user-a", action());
	assert.deepEqual(w.resolved, [{ userId: "user-a", conversationId: "conv-1" }]);
	assert.equal(w.fills.length, 2);
	assert.equal(w.fills[0]!.sessionId, "s-user-a-conv-1");
});

test("usuário B não usa a VM do usuário A (adaptador do run de A recusa B e o manager de B não enxerga a sessão de A)", async () => {
	const { deps, w } = world();
	const runA = createV4Sandbox({ scope: scope("user-a"), deps });
	await runA.run("user-a", action());
	const hijack = await runA.run("user-b", action());
	assert.equal(hijack.ok, false);
	assert.match(hijack.error ?? "", /another owner/);
	assert.equal(w.fills.length, 1, "a ação de B nunca chegou à VM");
	// release de B não solta a sessão de A
	await runA.release("user-b", "run-1");
	assert.equal(runA.activeSessionId(), "s-user-a-conv-1");
	// o manager de B, mesmo com o id da sessão de A, é recusado pela posse
	const managerB = deps.createManager("user-b");
	await assert.rejects(() => managerB.execCardFill("s-user-a-conv-1", action().params as unknown as ControlCardFillParams), /not found/);
	// o run de B tem a VM da conversa dele
	const runB = createV4Sandbox({ scope: scope("user-b", "conv-9", "run-2"), deps });
	await runB.run("user-b", action());
	assert.equal(w.fills.at(-1)!.sessionId, "s-user-b-conv-9");
});

test("sem Docker/VM: ok=false com frase honesta e sem o corpo da ação no log; a próxima ação tenta de novo", async () => {
	const { deps, w } = world();
	w.resolveFails = true;
	const logs: string[] = [];
	const sandbox = createV4Sandbox({ scope: scope(), deps, log: (m) => logs.push(m) });
	const result = await sandbox.run("user-a", action());
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /could not be started/);
	assert.equal(w.fills.length, 0);
	for (const secret of SECRETS) assert.equal((JSON.stringify(result) + logs.join("\n")).includes(secret), false);
	w.resolveFails = false;
	assert.equal((await sandbox.run("user-a", action())).ok, true);
});

test("kind desconhecido: erro honesto; registro extensível recebe a sessão pronta", async () => {
	const { deps } = world();
	const plain = createV4Sandbox({ scope: scope(), deps });
	const unknown = await plain.run("user-a", { kind: "browser_read", params: {} });
	assert.equal(unknown.ok, false);
	assert.match(unknown.error ?? "", /does not support/);
	const seen: string[] = [];
	const extended = createV4Sandbox({ scope: scope(), deps, handlers: { browser_read: async (ctx) => (seen.push(`${ctx.userId}:${ctx.runId}:${ctx.sessionId}`), { ok: true, data: "pagina" }) } });
	assert.deepEqual(await extended.run("user-a", { kind: "browser_read", params: {} }), { ok: true, data: "pagina" });
	assert.deepEqual(seen, ["user-a:run-1:s-user-a-conv-1"]);
});

test("release: a VM da conversa continua ligada; a VM criada sem conversa é destruída; só o dono do run libera", async () => {
	const { deps, w } = world();
	const withConversation = createV4Sandbox({ scope: scope(), deps });
	await withConversation.run("user-a", action());
	await withConversation.release("user-a", "run-1");
	assert.deepEqual(w.destroyed, []);
	assert.equal(withConversation.activeSessionId(), null);
	const noConversation = createV4Sandbox({ scope: scope("user-a", null, "run-3"), deps });
	await noConversation.run("user-a", action());
	await noConversation.release("user-a", "outro-run");
	assert.deepEqual(w.destroyed, []);
	await noConversation.release("user-a", "run-3");
	assert.deepEqual(w.destroyed, ["s-user-a-none"]);
});

test("card_fill de ponta a ponta pela porta CardFill: paid, declined e failed chegam sem segredo", async () => {
	for (const [control, expected] of [
		[{ state: "paid", orderRef: "PED-12345" }, { status: "paid", orderRef: "PED-12345" }],
		[{ state: "declined", reason: "Nothing was paid: the total on the store's payment page is not the amount the owner approved." }, { status: "declined" }],
		[{ state: "failed", reason: "Nothing was paid: the card form was not found." }, { status: "failed" }],
	] as const) {
		const { deps, w } = world(async () => control);
		const { fill, input, deposit } = fillPort(createV4Sandbox({ scope: scope(), deps }));
		await deposit();
		const result = await fill.fill(input);
		assert.equal(result.status, expected.status);
		if ("orderRef" in expected) assert.equal((result as { orderRef?: string }).orderRef, expected.orderRef);
		assert.equal(w.fills.length, 1);
		assert.deepEqual({ ...w.fills[0]!.params, cvv: "x", card: "x" }, { url: "https://loja.exemplo.com/checkout", merchant: "loja.exemplo.com", amount: 129.9, currency: "BRL", cvv: "x", card: "x" });
		for (const secret of SECRETS) assert.equal(JSON.stringify(result).includes(secret), false);
	}
});

test("desafio (3DS, app do banco, captcha) vira challenge e a ação vai à VM uma única vez", async () => {
	for (const kind of ["3ds", "bank_app", "captcha", "other"] as const) {
		const { deps, w } = world(async () => ({ state: "challenge", kind }));
		const { fill, input, deposit } = fillPort(createV4Sandbox({ scope: scope(), deps }));
		await deposit();
		assert.deepEqual(await fill.fill(input), { status: "challenge", kind });
		assert.equal(w.fills.length, 1);
		// O CVV é de uso único: repetir o pedido sem novo cartão de aprovação não chega à VM.
		assert.deepEqual(await fill.fill(input), { status: "no_cvv" });
		assert.equal(w.fills.length, 1, "o pagamento não é repetido");
	}
});

test("kind de desafio inventado pelo servidor vira other; estado desconhecido vira failed", async () => {
	const forged = world(async () => ({ state: "challenge", kind: "hack" as never }));
	const a = fillPort(createV4Sandbox({ scope: scope(), deps: forged.deps }));
	await a.deposit();
	assert.deepEqual(await a.fill.fill(a.input), { status: "challenge", kind: "other" });
	const odd = world(async () => ({ state: "teleport" as never }));
	const b = fillPort(createV4Sandbox({ scope: scope(), deps: odd.deps }));
	await b.deposit();
	assert.equal((await b.fill.fill(b.input)).status, "failed");
});

test("nenhum segredo em resultado, erro nem log: servidor hostil que ecoa o cartão e queda no meio do pagamento", async () => {
	const logs: string[] = [];
	const hostile = world(async () => ({ state: "declined", reason: `Recusado para ${CARD.number} ${CARD.holder} cvv ${CVV} em ${CARD.billing.line1}`, orderRef: CARD.number }));
	const a = fillPort(createV4Sandbox({ scope: scope(), deps: hostile.deps, log: (m) => logs.push(m) }));
	await a.deposit();
	const hostileResult = await a.fill.fill(a.input);

	const dropped = world(async () => { throw new Error(`socket hang up ${CARD.number} ${CVV} ${CARD.holder}`); });
	const b = fillPort(createV4Sandbox({ scope: scope(), deps: dropped.deps, log: (m) => logs.push(m) }));
	await b.deposit();
	const droppedResult = await b.fill.fill(b.input);

	const rejected = world(async () => { throw new SandboxControlError(`bad ${CARD.number}`, 413); });
	const c = fillPort(createV4Sandbox({ scope: scope(), deps: rejected.deps, log: (m) => logs.push(m) }));
	await c.deposit();
	const rejectedResult = await c.fill.fill(c.input);

	const wire = JSON.stringify([hostileResult, droppedResult, rejectedResult]) + logs.join("\n");
	for (const secret of SECRETS) assert.equal(wire.includes(secret), false, `vazou ${secret.slice(0, 4)}...`);
	assert.equal(hostileResult.status, "declined");
	// queda no meio: pode ter cobrado, então é failed (que o checkout manda conferir o pedido), não "unavailable"
	assert.equal(droppedResult.status, "failed");
	assert.match((droppedResult as { reason: string }).reason, /may have been charged/);
	assert.equal(rejectedResult.status, "failed");
	assert.match((rejectedResult as { reason: string }).reason, /Nothing was paid/);
});

test("pedido de pagamento incompleto nunca chega à VM", async () => {
	const { deps, w } = world();
	const sandbox = createV4Sandbox({ scope: scope(), deps });
	for (const bad of [{ cvv: "" }, { amount: -1 }, { url: "" }, { card: null }, { currency: "REAIS" }]) {
		const result = await sandbox.run("user-a", action(bad));
		assert.equal(result.ok, false);
	}
	assert.equal(w.fills.length, 0);
});

test("sem config (SANDBOX_ENABLED=0) não há adaptador: o run segue com a VM indisponível", () => {
	assert.equal(realV4SandboxDeps({ SANDBOX_ENABLED: "0" } as NodeJS.ProcessEnv), null);
	assert.equal(realV4SandboxDeps({ SANDBOX_ENABLED: "false" } as NodeJS.ProcessEnv), null);
	assert.notEqual(realV4SandboxDeps({ SANDBOX_ENABLED: "true" } as NodeJS.ProcessEnv), null);
});
