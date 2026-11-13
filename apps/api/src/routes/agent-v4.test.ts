/**
 * Respostas do dono a pedidos do motor v4 (F2.6): caminho feliz, expiração, idempotência e IDOR (40-seguranca).
 * Sem banco real: delegates do prisma dublados com um estado em memória (mesma técnica de `runs-security.test.ts`).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/agent-v4.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { prisma } = await import("@workspace/db");
const { createAgentV4Routes } = await import("./agent-v4.js");

const A = "v4-owner-a";
const B = "v4-owner-b";
const T0 = new Date("2026-11-06T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const restorers: (() => void)[] = [];
function stubMethod<T extends object, K extends keyof T>(object: T, key: K, fake: (...args: never[]) => unknown) {
	const original = object[key];
	const replacement = mock.fn(fake);
	Object.defineProperty(object, key, { value: replacement, configurable: true, writable: true });
	restorers.push(() => Object.defineProperty(object, key, { value: original, configurable: true, writable: true }));
	return replacement;
}
afterEach(() => {
	for (const restore of restorers.reverse()) restore();
	restorers.length = 0;
});

type RequestRow = { userId: string; runId: string; kind: string; key: string; callId: string | null; toolName: string | null; payloadHash: string | null; conversationId: string | null; state: string; expiresAt: Date | null; decidedAt: Date | null; consumedAt: Date | null };
type RunRow = { id: string; userId: string; status: string };

/** Estado em memória por trás dos delegates do prisma: run, pedidos e ofertas. */
function world(opts: { runStatus?: string; both?: boolean; toolName?: string } = {}) {
	const runs: RunRow[] = [{ id: "run-a", userId: A, status: opts.runStatus ?? "paused" }];
	const requests: RequestRow[] = [
		{ userId: A, runId: "run-a", kind: "approval", key: "req-1", callId: "c1", toolName: opts.toolName ?? "send_email", payloadHash: "hash-1", conversationId: "conv-a", state: "pending", expiresAt: new Date(T0.getTime() + DAY), decidedAt: null, consumedAt: null },
		{ userId: A, runId: "run-a", kind: "handoff", key: "c2", callId: "c2", toolName: null, payloadHash: null, conversationId: "conv-a", state: "pending", expiresAt: new Date(T0.getTime() + DAY), decidedAt: null, consumedAt: null },
	];
	// A maioria dos testes olha um pedido só (o run retoma assim que ele é respondido); `both` mantém também o handoff.
	if (!opts.both) requests.splice(1, 1);
	const offers = [{ userId: A, cardId: "run-a:ask1", conversationId: "conv-a", state: "open" }];
	const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
		Object.entries(where).every(([k, v]) => {
			if (v && typeof v === "object" && "in" in (v as object)) return ((v as { in: unknown[] }).in).includes(row[k]);
			if (v && typeof v === "object" && "lte" in (v as object)) return (row[k] as Date) <= (v as { lte: Date }).lte;
			return row[k] === v;
		});
	const runRow = (r: RunRow) => ({ id: r.id, userId: r.userId, botId: null, conversationId: "conv-a", origin: "chat", objective: "o", status: r.status, model: "m", maxSteps: 10, sandboxSessionId: null, error: null, resultText: null, cancelRequested: false, budgetJson: null, usageJson: null, createdAt: T0, updatedAt: T0, startedAt: T0, finishedAt: null, leaseUntil: null, jobEnqueuedAt: null });

	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { id: string; userId: string } }) => {
		const r = runs.find((x) => x.id === where.id && x.userId === where.userId);
		return r ? runRow(r) : null;
	});
	stubMethod(prisma.agentRun, "findUnique", async ({ where }: { where: { id: string } }) => {
		const r = runs.find((x) => x.id === where.id);
		return r ? runRow(r) : null;
	});
	const resumeUpdate = stubMethod(prisma.agentRun, "updateMany", async ({ where }: { where: { id: string; status: string } }) => {
		const r = runs.find((x) => x.id === where.id && x.status === where.status);
		if (r) r.status = "queued";
		return { count: r ? 1 : 0 };
	});
	stubMethod(prisma.agentRun, "update", async () => ({}));
	stubMethod(prisma.agentV4Request, "findFirst", async ({ where }: { where: Record<string, unknown> }) => requests.find((r) => matches(r as never, where)) ?? null);
	stubMethod(prisma.agentV4Request, "findMany", async ({ where }: { where: Record<string, unknown> }) => requests.filter((r) => matches(r as never, where)));
	stubMethod(prisma.agentV4Request, "updateMany", async ({ where, data }: { where: Record<string, unknown>; data: Partial<RequestRow> }) => {
		const hit = requests.filter((r) => matches(r as never, where));
		for (const r of hit) Object.assign(r, data);
		return { count: hit.length };
	});
	stubMethod(prisma.agentV4Request, "createMany", async ({ data }: { data: RequestRow[] }) => {
		let count = 0;
		for (const row of data) if (!requests.some((r) => r.userId === row.userId && r.runId === row.runId && r.kind === row.kind && r.key === row.key)) (requests.push({ ...row, callId: row.callId ?? null, toolName: row.toolName ?? null, payloadHash: row.payloadHash ?? null, expiresAt: row.expiresAt ?? null, consumedAt: row.consumedAt ?? null }), count++);
		return { count };
	});
	stubMethod(prisma.agentConversationOffer, "findFirst", async ({ where }: { where: Record<string, unknown> }) => offers.find((o) => matches(o as never, where)) ?? null);
	return { runs, requests, resumeUpdate };
}

function appFor(userId: string, opts: { queue?: { add: () => Promise<unknown> } | null; now?: Date; escrow?: { deposit: (scope: unknown, cvv: string, ttl: number) => Promise<boolean>; discard: (scope: unknown) => Promise<void> } | null } = {}) {
	const add = mock.fn(opts.queue?.add ?? (async () => ({ id: "job" })));
	const queue = opts.queue === null ? null : ({ add, getJob: async () => undefined } as never);
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId, name: "Test", email: "owner@example.com", emailVerified: true, createdAt: T0, updatedAt: T0 }, session: { id: "s", token: "t", userId, expiresAt: T0, createdAt: T0, updatedAt: T0, ipAddress: null, userAgent: null } });
		await next();
	});
	app.route("/", createAgentV4Routes({ queue, clock: () => opts.now ?? T0, ...(opts.escrow !== undefined && { cvvEscrow: opts.escrow as never }) }));
	return { app, add };
}

const respond = (app: Hono<AuthEnv>, path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const REQ = "/v1/agent-v4/runs/run-a/requests";

test("aprovar grava a decisão com o hash do pedido, retoma o run e enfileira uma vez", async () => {
	const w = world();
	const { app, add } = appFor(A);
	const res = await respond(app, `${REQ}/req-1/respond`, { decision: "approve" });
	assert.equal(res.status, 200);
	const json = (await res.json()) as { ok: boolean; status: string; resumed: boolean };
	assert.deepEqual({ ok: json.ok, status: json.status, resumed: json.resumed }, { ok: true, status: "recorded", resumed: true });
	const row = w.requests.find((r) => r.key === "req-1")!;
	assert.equal(row.state, "approved");
	assert.equal(row.payloadHash, "hash-1");
	assert.equal(w.runs[0]!.status, "queued");
	assert.equal(add.mock.callCount(), 1);
});

test("'Agora não' grava denied; handoff concluído grava done; decisão errada para o tipo é 400", async () => {
	const w = world({ both: true });
	const { app } = appFor(A);
	assert.equal((await respond(app, `${REQ}/req-1/respond`, { decision: "deny" })).status, 200);
	assert.equal(w.requests.find((r) => r.key === "req-1")!.state, "denied");
	w.runs[0]!.status = "paused";
	assert.equal((await respond(app, `${REQ}/c2/respond`, { decision: "approve" })).status, 400);
	assert.equal((await respond(app, `${REQ}/c2/respond`, { decision: "handoff_done" })).status, 200);
	assert.equal(w.requests.find((r) => r.key === "c2")!.state, "done");
});

test("R4: com dois pedidos do mesmo run, só a última resposta reenfileira (a primeira avisa quantos faltam)", async () => {
	const w = world({ both: true });
	const { app, add } = appFor(A);
	const first = await respond(app, `${REQ}/req-1/respond`, { decision: "approve" });
	assert.equal(first.status, 200);
	assert.deepEqual({ ...(await first.json() as object), request: undefined }, { ok: true, status: "recorded", decision: "approve", resumed: false, pending: 1, request: undefined });
	assert.equal(w.runs[0]!.status, "paused", "o run segue estacionado");
	assert.equal(add.mock.callCount(), 0);
	// repetir a primeira não reenfileira enquanto o outro pedido espera
	assert.equal(((await (await respond(app, `${REQ}/req-1/respond`, { decision: "approve" })).json()) as { resumed: boolean }).resumed, false);
	assert.equal(add.mock.callCount(), 0);
	const last = await respond(app, `${REQ}/c2/respond`, { decision: "handoff_done" });
	assert.equal(last.status, 200);
	assert.equal(((await last.json()) as { resumed: boolean }).resumed, true);
	assert.equal(w.runs[0]!.status, "queued");
	assert.equal(add.mock.callCount(), 1);
});

test("R4: pedido do mesmo run que venceu sem resposta não segura a retomada", async () => {
	const w = world({ both: true });
	w.requests.find((r) => r.key === "c2")!.expiresAt = new Date(T0.getTime() + 1000);
	const { app, add } = appFor(A, { now: new Date(T0.getTime() + 2000) });
	const res = await respond(app, `${REQ}/req-1/respond`, { decision: "approve" });
	assert.equal(res.status, 200);
	assert.equal(((await res.json()) as { resumed: boolean }).resumed, true);
	assert.equal(w.requests.find((r) => r.key === "c2")!.state, "expired");
	assert.equal(add.mock.callCount(), 1);
});

test("clique repetido é idempotente e decisão diferente depois é 409", async () => {
	world();
	const { app } = appFor(A);
	assert.equal((await respond(app, `${REQ}/req-1/respond`, { decision: "approve" })).status, 200);
	// o run já foi retomado (queued): repetir a mesma decisão devolve 200 sem reenfileirar
	const again = await respond(app, `${REQ}/req-1/respond`, { decision: "approve" });
	assert.equal(again.status, 200);
	assert.deepEqual(await again.json(), { ok: true, status: "already", decision: "approve", resumed: false });
	assert.equal((await respond(app, `${REQ}/req-1/respond`, { decision: "deny" })).status, 409);
});

test("pedido que passou do prazo (24h) responde 410, não aceita aprovação e nada é reenfileirado", async () => {
	const w = world();
	const { app, add } = appFor(A, { now: new Date(T0.getTime() + DAY + 1) });
	const res = await respond(app, `${REQ}/req-1/respond`, { decision: "approve" });
	assert.equal(res.status, 410);
	assert.equal(w.requests.find((r) => r.key === "req-1")!.state, "expired");
	assert.equal(add.mock.callCount(), 0);
	assert.equal(w.runs[0]!.status, "paused");
	// dentro do prazo (menos de 24h) o mesmo pedido aceita
	const w2 = world();
	void w2;
	const early = appFor(A, { now: new Date(T0.getTime() + DAY - 1000) });
	assert.equal((await respond(early.app, `${REQ}/req-1/respond`, { decision: "approve" })).status, 200);
});

test("run que ainda não estacionou pede para repetir e não grava nada", async () => {
	const w = world({ runStatus: "running" });
	const { app, add } = appFor(A);
	const res = await respond(app, `${REQ}/req-1/respond`, { decision: "approve" });
	assert.equal(res.status, 409);
	assert.deepEqual(await res.json(), { error: "run_not_paused", retryable: true });
	assert.equal(w.requests.find((r) => r.key === "req-1")!.state, "pending");
	assert.equal(add.mock.callCount(), 0);
});

test("corpo inválido é 400 (campo desconhecido, decisão fora do enum, sem JSON) e fila ausente é 503 sem gravar", async () => {
	const w = world();
	const { app } = appFor(A);
	for (const body of [{ decision: "maybe" }, { decision: "approve", userId: B }, {}, null]) assert.equal((await respond(app, `${REQ}/req-1/respond`, body)).status, 400);
	const noQueue = appFor(A, { queue: null });
	assert.equal((await respond(noQueue.app, `${REQ}/req-1/respond`, { decision: "approve" })).status, 503);
	assert.equal(w.requests.find((r) => r.key === "req-1")!.state, "pending");
});

test("IDOR: o usuário B não aprova, recusa nem conclui o pedido do usuário A (404 igual a inexistente) e nada muda", async () => {
	const w = world({ both: true });
	const b = appFor(B);
	for (const decision of ["approve", "deny", "handoff_done"]) {
		assert.equal((await respond(b.app, `${REQ}/req-1/respond`, { decision })).status, 404);
		assert.equal((await respond(b.app, `${REQ}/c2/respond`, { decision })).status, 404);
	}
	assert.equal((await respond(b.app, `${REQ}/inexistente/respond`, { decision: "approve" })).status, 404);
	assert.deepEqual(w.requests.map((r) => r.state), ["pending", "pending"]);
	assert.equal(w.runs[0]!.status, "paused");
	assert.equal(b.add.mock.callCount(), 0);
	// B também não repete uma decisão que A já tomou
	const a = appFor(A);
	assert.equal((await respond(a.app, `${REQ}/req-1/respond`, { decision: "approve" })).status, 200);
	assert.equal((await respond(b.app, `${REQ}/req-1/respond`, { decision: "approve" })).status, 404);
	assert.equal((await respond(b.app, `${REQ}/req-1/respond`, { decision: "deny" })).status, 404);
});

test("userId no corpo ou na query não vira escopo: vale a sessão", async () => {
	const w = world();
	const b = appFor(B);
	assert.equal((await b.app.request(`${REQ}/req-1/respond?userId=${A}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }) })).status, 404);
	assert.equal((await respond(b.app, `${REQ}/req-1/respond`, { decision: "approve", userId: A })).status, 400);
	assert.equal(w.requests[0]!.state, "pending");
});

test("cartão ask_owner: o dono dispensa uma vez; B recebe 404; repetir é already; outra resposta é 409", async () => {
	const w = world();
	const a = appFor(A);
	const b = appFor(B);
	const path = `/v1/agent-v4/cards/${encodeURIComponent("run-a:ask1")}/respond`;
	assert.equal((await respond(b.app, path, { response: "dismissed" })).status, 404);
	assert.equal(w.requests.filter((r) => r.kind === "card").length, 0);
	const first = await respond(a.app, path, { response: "dismissed" });
	assert.deepEqual(await first.json(), { ok: true, status: "recorded" });
	assert.equal(w.requests.find((r) => r.kind === "card")!.state, "dismissed");
	assert.deepEqual(await (await respond(a.app, path, { response: "dismissed" })).json(), { ok: true, status: "already" });
	assert.equal((await respond(a.app, path, { response: "answered" })).status, 409);
	assert.equal((await respond(a.app, path, { response: "talvez" })).status, 400);
	assert.equal((await respond(a.app, `/v1/agent-v4/cards/${encodeURIComponent("run-a:outro")}/respond`, { response: "dismissed" })).status, 404);
});

// ------------------------------------------------------------------ CVV (F6.3)

function fakeEscrow() {
	const deposits: Array<{ scope: { userId: string; runId: string; requestId: string }; cvv: string; ttl: number }> = [];
	const discards: unknown[] = [];
	// Canal com a semântica real: guarda só se não existe (NX), descarte apaga.
	const stored = new Map<string, string>();
	const keyOf = (scope: unknown) => JSON.stringify(scope);
	return {
		deposits,
		discards,
		stored,
		deposit: async (scope: unknown, cvv: string, ttl: number) => {
			deposits.push({ scope: scope as never, cvv, ttl });
			if (stored.has(keyOf(scope))) return false;
			stored.set(keyOf(scope), cvv);
			return true;
		},
		discard: async (scope: unknown) => {
			discards.push(scope);
			stored.delete(keyOf(scope));
		},
	};
}

test("compra: aprovar com CVV deposita no canal efêmero ligado ao pedido e NÃO grava o CVV em lugar nenhum", async () => {
	const w = world({ toolName: "checkout" });
	const escrow = fakeEscrow();
	const { app } = appFor(A, { escrow });
	const res = await respond(app, `${REQ}/req-1/respond`, { decision: "approve", cvv: "737" });
	assert.equal(res.status, 200);
	assert.deepEqual(escrow.deposits.map((d) => ({ ...d.scope, ttl: d.ttl })), [{ userId: A, runId: "run-a", requestId: "req-1", ttl: 15 * 60_000 }]);
	assert.equal(escrow.deposits[0]!.cvv, "737");
	assert.equal(escrow.discards.length, 0);
	assert.equal(w.requests.find((r) => r.key === "req-1")!.state, "approved");
	// nada do CVV sobe nem na resposta nem nas linhas gravadas
	assert.equal(JSON.stringify(await res.clone().json()).includes("737"), false);
	assert.equal(JSON.stringify(w.requests).includes("737"), false);
});

test("compra: aprovar SEM CVV ou com CVV inválido é 400 e não decide nem deposita", async () => {
	const w = world({ toolName: "checkout" });
	const escrow = fakeEscrow();
	const { app } = appFor(A, { escrow });
	for (const body of [{ decision: "approve" }, { decision: "approve", cvv: "12" }, { decision: "approve", cvv: "12345" }, { decision: "approve", cvv: "12a" }]) {
		const res = await respond(app, `${REQ}/req-1/respond`, body);
		assert.equal(res.status, 400);
		assert.equal(((await res.json()) as { error: string }).error, "cvv_required");
	}
	assert.equal(escrow.deposits.length, 0);
	assert.equal(w.requests.find((r) => r.key === "req-1")!.state, "pending");
});

test("compra: 'Agora não' não precisa de CVV; cvv fora de compra aprovada é 400", async () => {
	const w = world({ toolName: "checkout", both: true });
	const escrow = fakeEscrow();
	const { app } = appFor(A, { escrow });
	assert.equal((await respond(app, `${REQ}/req-1/respond`, { decision: "deny", cvv: "737" })).status, 400);
	assert.equal((await respond(app, `${REQ}/req-1/respond`, { decision: "deny" })).status, 200);
	assert.equal(w.requests.find((r) => r.key === "req-1")!.state, "denied");
	assert.equal(escrow.deposits.length, 0);
});

test("outro tipo de pedido não aceita cvv (nada é guardado)", async () => {
	const w = world();
	const escrow = fakeEscrow();
	const { app } = appFor(A, { escrow });
	assert.equal((await respond(app, `${REQ}/req-1/respond`, { decision: "approve", cvv: "737" })).status, 400);
	assert.equal(escrow.deposits.length, 0);
	assert.equal(w.requests.find((r) => r.key === "req-1")!.state, "pending");
});

test("compra sem canal do CVV: 503 e nada é aprovado", async () => {
	const w = world({ toolName: "checkout" });
	const { app } = appFor(A, { escrow: null });
	const res = await respond(app, `${REQ}/req-1/respond`, { decision: "approve", cvv: "737" });
	assert.equal(res.status, 503);
	assert.equal(w.requests.find((r) => r.key === "req-1")!.state, "pending");
});

test("compra: segundo clique com a decisão já gravada NÃO deposita de novo (CVV de uso único)", async () => {
	world({ toolName: "checkout" });
	const escrow = fakeEscrow();
	const { app } = appFor(A, { escrow });
	assert.equal((await respond(app, `${REQ}/req-1/respond`, { decision: "approve", cvv: "737" })).status, 200);
	const again = await respond(app, `${REQ}/req-1/respond`, { decision: "approve", cvv: "737" });
	assert.equal(again.status, 200);
	assert.equal(escrow.deposits.length, 1);
});

test("compra: pedido de outro dono é 404 e o CVV não é depositado", async () => {
	world({ toolName: "checkout" });
	const escrow = fakeEscrow();
	const b = appFor(B, { escrow });
	assert.equal((await respond(b.app, `${REQ}/req-1/respond`, { decision: "approve", cvv: "737" })).status, 404);
	assert.equal(escrow.deposits.length, 0);
});

test("compra: pedido vencido (410) descarta o CVV que acabou de depositar", async () => {
	world({ toolName: "checkout" });
	const escrow = fakeEscrow();
	const { app } = appFor(A, { escrow, now: new Date(T0.getTime() + 2 * DAY) });
	assert.equal((await respond(app, `${REQ}/req-1/respond`, { decision: "approve", cvv: "737" })).status, 410);
	assert.equal(escrow.deposits.length, escrow.discards.length);
});

test("compra: dois cliques em corrida com CVV: o do primeiro fica no canal e o segundo ('already') não o apaga", async () => {
	world({ toolName: "checkout" });
	const escrow = fakeEscrow();
	const { app } = appFor(A, { escrow });
	const [first, second] = await Promise.all([respond(app, `${REQ}/req-1/respond`, { decision: "approve", cvv: "737" }), respond(app, `${REQ}/req-1/respond`, { decision: "approve", cvv: "919" })]);
	assert.equal(first.status, 200);
	assert.equal(second.status, 200);
	assert.deepEqual([(await first.json() as { status: string }).status, (await second.json() as { status: string }).status].sort(), ["already", "recorded"]);
	assert.equal(escrow.discards.length, 0);
	assert.equal(escrow.stored.size, 1);
	assert.equal([...escrow.stored.values()][0], "737");
});

test("compra: se o descarte do CVV falhar, o aviso vai ao log sem o valor e a resposta segue", async () => {
	world({ toolName: "checkout" });
	const escrow = { ...fakeEscrow(), discard: async () => { throw new Error("redis caiu com 737"); } };
	const warned: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
	try {
		const { app } = appFor(A, { escrow, now: new Date(T0.getTime() + 2 * DAY) });
		assert.equal((await respond(app, `${REQ}/req-1/respond`, { decision: "approve", cvv: "737" })).status, 410);
	} finally {
		console.warn = original;
	}
	assert.equal(warned.length, 1);
	assert.match(warned[0]!, /não consegui descartar o CVV/);
	assert.match(warned[0]!, /run=run-a/);
	assert.equal(warned[0]!.includes("737"), false);
});
