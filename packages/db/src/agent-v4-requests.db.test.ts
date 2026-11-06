/**
 * Pedidos do v4 contra Postgres real (F2.6). Pulado sem ATLAS_TEST_DB_URL.
 * Runner: `pnpm --filter @workspace/db test:db`.
 * Cobre o caminho feliz, a decisão atômica, a expiração e o acesso de OUTRO dono (40-seguranca).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
	AGENT_V4_REQUEST_TTL_MS,
	consumeAgentV4CardResponses,
	decideAgentV4Request,
	expireDueAgentV4Requests,
	getAgentV4ConversationProvenance,
	listAgentV4CardResponses,
	listAgentV4History,
	loadAgentV4Decisions,
	recordAgentV4CardResponse,
	registerAgentV4Requests,
} from "./agent-v4-requests.js";
import { saveAgentConversationState } from "./agent-v4-store.js";
import { ResourceOwnershipError } from "./conversations.js";
import { prisma } from "./client.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

describe("agent-v4-requests (Postgres real)", { skip: dbSkip }, () => {
	let a: string;
	let b: string;
	let conv: string;
	let runA: string;
	const t0 = new Date("2026-11-06T12:00:00.000Z");
	const later = (ms: number) => new Date(t0.getTime() + ms);

	before(async () => {
		a = (await createTestUser("v4ra")).id;
		b = (await createTestUser("v4rb")).id;
		conv = (await prisma.conversation.create({ data: { userId: a } })).id;
		runA = (await prisma.agentRun.create({ data: { userId: a, conversationId: conv, objective: "o", model: "m", status: "paused" } })).id;
		await registerAgentV4Requests(a, runA, conv, [
			{ kind: "approval", key: "req-1", callId: "c1", toolName: "send_email", payloadHash: "h1" },
			{ kind: "approval", key: "req-2", callId: "c2", toolName: "send_email", payloadHash: "h2" },
			{ kind: "handoff", key: "c3", callId: "c3" },
		], t0);
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("outro dono: registrar em run alheio falha e decidir é not_found", async () => {
		await assert.rejects(registerAgentV4Requests(b, runA, conv, [{ kind: "approval", key: "x", callId: "c", payloadHash: "h" }], t0), ResourceOwnershipError);
		assert.deepEqual(await decideAgentV4Request(b, runA, "req-1", "approve", t0), { status: "not_found" });
		assert.equal((await loadAgentV4Decisions(b, runA, t0)).pending, 0);
	});

	test("decisão atômica: aprova uma vez, repetir é already, outra decisão é conflict", async () => {
		assert.equal((await decideAgentV4Request(a, runA, "req-1", "approve", later(1000))).status, "recorded");
		assert.equal((await decideAgentV4Request(a, runA, "req-1", "approve", later(2000))).status, "already");
		assert.equal((await decideAgentV4Request(a, runA, "req-1", "deny", later(3000))).status, "conflict");
		assert.deepEqual(await decideAgentV4Request(a, runA, "c3", "approve", later(1000)), { status: "invalid_decision", kind: "handoff" });
	});

	test("retomada: grant com o hash do pedido, recusa e handoff; pendente dentro do prazo continua pendente", async () => {
		assert.equal((await decideAgentV4Request(a, runA, "c3", "handoff_done", later(1000))).status, "recorded");
		const d = await loadAgentV4Decisions(a, runA, later(5000));
		assert.deepEqual(d.approved.map((g) => [g.requestId, g.payloadHash]), [["req-1", "h1"]]);
		assert.deepEqual(d.handoffDone, ["c3"]);
		assert.equal(d.pending, 1);
	});

	test("expiração: passado o prazo o pendente vira expired, não aceita decisão, e dentro do prazo nada expira", async () => {
		assert.equal(await expireDueAgentV4Requests(a, conv, later(AGENT_V4_REQUEST_TTL_MS - 1)), 0);
		const out = await decideAgentV4Request(a, runA, "req-2", "approve", later(AGENT_V4_REQUEST_TTL_MS + 1));
		assert.equal(out.status, "expired");
		const d = await loadAgentV4Decisions(a, runA, later(AGENT_V4_REQUEST_TTL_MS + 1));
		assert.deepEqual(d.expired, ["req-2"]);
		assert.equal(d.pending, 0);
	});

	test("cartões: só oferta aberta do próprio dono; resposta fica até o run seguinte consumir", async () => {
		const cardId = `${runA}:ask1`;
		await saveAgentConversationState(a, conv, { offers: [{ cardId, label: "continuar", state: "open" }], declinedOffers: [] });
		assert.deepEqual(await recordAgentV4CardResponse(b, cardId, "dismissed", t0), { status: "not_found" });
		assert.equal((await recordAgentV4CardResponse(a, cardId, "dismissed", t0)).status, "recorded");
		assert.equal((await recordAgentV4CardResponse(a, cardId, "dismissed", t0)).status, "already");
		assert.equal((await recordAgentV4CardResponse(a, cardId, "answered", t0)).status, "conflict");
		assert.deepEqual(await listAgentV4CardResponses(a, conv), [{ cardId, response: "dismissed" }]);
		assert.deepEqual(await listAgentV4CardResponses(b, conv), []);
		await consumeAgentV4CardResponses(a, conv, [cardId], t0);
		assert.deepEqual(await listAgentV4CardResponses(a, conv), []);
	});

	test("histórico só da conversa do dono e proveniência lida do checkpoint dos outros runs", async () => {
		await prisma.conversationMessage.createMany({ data: [{ conversationId: conv, role: "user", content: "oi" }, { conversationId: conv, role: "assistant", content: "olá" }, { conversationId: conv, role: "tool", content: "x" }] });
		assert.deepEqual((await listAgentV4History(a, conv)).map((m) => m.content), ["oi", "olá"]);
		assert.deepEqual(await listAgentV4History(b, conv), []);
		const other = await prisma.agentRun.create({ data: { userId: a, conversationId: conv, objective: "o", model: "m", status: "completed", checkpointJson: { v4: { step: 1, state: "DONE", payload: { provenance: { untrustedReadInRun: true, privateReadInRun: false, sources: ["web"], texts: ["pagina"] } } } } } });
		assert.deepEqual(await getAgentV4ConversationProvenance(a, conv, runA), { untrustedReadInRun: true, privateReadInRun: false, sources: ["web"] });
		assert.deepEqual(await getAgentV4ConversationProvenance(a, conv, other.id), { untrustedReadInRun: false, privateReadInRun: false, sources: [] });
		assert.deepEqual(await getAgentV4ConversationProvenance(b, conv, runA), { untrustedReadInRun: false, privateReadInRun: false, sources: [] });
	});
});
