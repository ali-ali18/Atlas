/**
 * Store do motor v4 contra Postgres real (F1.12). Pulado sem ATLAS_TEST_DB_URL.
 * Runner: `pnpm --filter @workspace/db test:db`.
 * Cobre o caminho feliz e o acesso de OUTRO dono (40-seguranca): B não lê, altera nem apaga o que é de A.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
	appendAgentJournalEntry,
	appendAgentReceipt,
	assertAgentV4Lease,
	findAgentJournalEntry,
	getAgentConversationState,
	getAgentNote,
	listAgentJournalEntries,
	listAgentNotes,
	listAgentReceipts,
	loadAgentV4Checkpoint,
	removeAgentNote,
	saveAgentConversationState,
	saveAgentNote,
	hasAgentV4Checkpoint,
	saveAgentV4Checkpoint,
	saveAgentV4CheckpointUnfenced,
} from "./agent-v4-store.js";
import { ResourceOwnershipError } from "./conversations.js";
import { prisma } from "./client.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("agent-v4-store (Postgres real)", { skip: dbSkip }, () => {
	let a: string;
	let b: string;
	let runA: string;

	before(async () => {
		a = (await createTestUser("v4a")).id;
		b = (await createTestUser("v4b")).id;
		runA = (await prisma.agentRun.create({ data: { userId: a, objective: "o", model: "m", status: "running", checkpointJson: { llmMessages: [], keep: "v2" } } })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	const entry = (over: Partial<Parameters<typeof appendAgentJournalEntry>[0]> = {}) => ({ runId: runA, userId: a, step: 1, idempotencyKey: `${runA}:c1:h`, toolName: "send_email", argsHash: "h", outcome: "started" as const, ...over });

	test("journal: started -> succeeded na mesma chave e started não rebaixa", async () => {
		await appendAgentJournalEntry(entry());
		assert.equal((await findAgentJournalEntry(a, runA, entry().idempotencyKey))?.outcome, "started");
		await appendAgentJournalEntry(entry({ outcome: "succeeded" }));
		await appendAgentJournalEntry(entry({ outcome: "started" }));
		assert.equal((await findAgentJournalEntry(a, runA, entry().idempotencyKey))?.outcome, "succeeded");
		assert.equal((await listAgentJournalEntries(a, runA)).filter((e) => e.idempotencyKey === entry().idempotencyKey).length, 1);
	});

	test("journal (B10): failed reassumida volta a started, e started/succeeded não se reassumem", async () => {
		const key = `${runA}:retry:h`;
		assert.deepEqual(await appendAgentJournalEntry(entry({ idempotencyKey: key })), { claimed: true });
		await appendAgentJournalEntry(entry({ idempotencyKey: key, outcome: "failed" }));
		assert.equal((await findAgentJournalEntry(a, runA, key))?.outcome, "failed");
		// nova tentativa: volta a started (uma retomada interrompida agora é detectável)
		assert.deepEqual(await appendAgentJournalEntry(entry({ idempotencyKey: key, step: 2 })), { claimed: true });
		const retried = await findAgentJournalEntry(a, runA, key);
		assert.equal(retried?.outcome, "started");
		assert.equal(retried?.step, 2);
		assert.deepEqual(await appendAgentJournalEntry(entry({ idempotencyKey: key })), { claimed: false });
		await appendAgentJournalEntry(entry({ idempotencyKey: key, outcome: "succeeded" }));
		assert.deepEqual(await appendAgentJournalEntry(entry({ idempotencyKey: key })), { claimed: false });
		// succeeded nunca é rebaixado, nem por failed
		await appendAgentJournalEntry(entry({ idempotencyKey: key, outcome: "failed" }));
		assert.equal((await findAgentJournalEntry(a, runA, key))?.outcome, "succeeded");
	});

	test("journal (S5): claims concorrentes da mesma chave, só um vence", async () => {
		const key = `${runA}:race:h`;
		const results = await Promise.all(Array.from({ length: 8 }, () => appendAgentJournalEntry(entry({ idempotencyKey: key }))));
		assert.equal(results.filter((r) => r.claimed).length, 1);
		assert.equal((await listAgentJournalEntries(a, runA)).filter((e) => e.idempotencyKey === key).length, 1);
	});

	test("S5: assertAgentV4Lease só passa com dono, token e validade do lease", async () => {
		const run = (await prisma.agentRun.create({ data: { userId: a, objective: "o", model: "m", status: "running", leaseOwner: "w1", leaseToken: "tok", leaseUntil: new Date(Date.now() + 60_000) } })).id;
		await assertAgentV4Lease(a, run, { owner: "w1", token: "tok" });
		await assert.rejects(assertAgentV4Lease(a, run, { owner: "w1", token: "outro" }), /lease_lost/);
		await assert.rejects(assertAgentV4Lease(a, run, { owner: "w2", token: "tok" }), /lease_lost/);
		await assert.rejects(assertAgentV4Lease(b, run, { owner: "w1", token: "tok" }), /lease_lost/);
		await prisma.agentRun.update({ where: { id: run }, data: { leaseUntil: new Date(Date.now() - 1000) } });
		await assert.rejects(assertAgentV4Lease(a, run, { owner: "w1", token: "tok" }), /lease_lost/);
		await assert.rejects(assertAgentV4Lease("default", run, { owner: "w1", token: "tok" }), ResourceOwnershipError);
	});

	test("journal: dono B não lê, não grava no run de A e a chave dele não colide com a de A", async () => {
		assert.equal(await findAgentJournalEntry(b, runA, entry().idempotencyKey), null);
		assert.deepEqual(await listAgentJournalEntries(b, runA), []);
		await assert.rejects(appendAgentJournalEntry(entry({ userId: b })), ResourceOwnershipError);
		assert.equal((await findAgentJournalEntry(a, runA, entry().idempotencyKey))?.outcome, "succeeded");
	});

	test("journal e recibo: dono vazio ou 'default' não grava nem lê", async () => {
		for (const owner of ["", "default", "  "]) {
			await assert.rejects(appendAgentJournalEntry(entry({ userId: owner })), ResourceOwnershipError);
			assert.deepEqual(await listAgentReceipts(owner, runA), []);
		}
	});

	test("recibos: grava com os campos opcionais e só o dono lista; B não grava no run de A", async () => {
		const at = new Date("2026-11-05T12:00:00.000Z");
		await appendAgentReceipt({ runId: runA, userId: a, toolName: "save_event", effect: "write_external", summary: "Evento criado", where: "Agenda", externalId: "ev-9", url: "https://exemplo.test/ev-9", at });
		await appendAgentReceipt({ runId: runA, userId: a, toolName: "save_file", effect: "write_local", summary: "Arquivo salvo", at: new Date(at.getTime() + 1000) });
		const list = await listAgentReceipts(a, runA);
		assert.deepEqual(list.map((r) => r.toolName), ["save_event", "save_file"]);
		assert.deepEqual(list[0], { runId: runA, userId: a, toolName: "save_event", effect: "write_external", summary: "Evento criado", where: "Agenda", externalId: "ev-9", url: "https://exemplo.test/ev-9", at });
		assert.equal("where" in list[1]!, false);
		assert.deepEqual(await listAgentReceipts(b, runA), []);
		await assert.rejects(appendAgentReceipt({ runId: runA, userId: b, toolName: "x", effect: "write_local", summary: "x", at }), ResourceOwnershipError);
	});

	test("notas: salvar, atualizar, listar e apagar; o mesmo id em dois donos não colide", async () => {
		await saveAgentNote({ id: "n1", userId: a, title: "T", body: "corpo A", pinned: false });
		await saveAgentNote({ id: "n1", userId: b, title: "T", body: "corpo B", pinned: true });
		await saveAgentNote({ id: "n1", userId: a, title: "T2", body: "corpo A2", pinned: true, sourceRunId: runA });
		assert.deepEqual(await getAgentNote(a, "n1"), { id: "n1", userId: a, title: "T2", body: "corpo A2", pinned: true, botId: null, sourceRunId: runA });
		assert.equal((await getAgentNote(b, "n1"))?.body, "corpo B");
		assert.equal((await listAgentNotes(a)).length, 1);
		assert.equal(await removeAgentNote(b, "n1"), true);
		assert.equal((await getAgentNote(a, "n1"))?.body, "corpo A2", "apagar a nota de B não toca na de A");
		assert.equal(await removeAgentNote(b, "n1"), false);
		assert.equal(await removeAgentNote(a, "n1"), true);
	});

	test("notas: dono vazio não grava, título/corpo enormes são recusados", async () => {
		await assert.rejects(saveAgentNote({ id: "n2", userId: "default", title: "T", body: "b", pinned: false }), ResourceOwnershipError);
		await assert.rejects(saveAgentNote({ id: "n2", userId: a, title: "T".repeat(501), body: "b", pinned: false }), RangeError);
		assert.equal(await getAgentNote("default", "n2"), null);
	});

	test("conversa: ofertas e rótulos declinados fazem o round-trip e são isolados por dono", async () => {
		const state = { offers: [{ cardId: "c1", label: "Quer que eu continue?", state: "dismissed" as const }, { cardId: "c2", label: "Outra", state: "open" as const }], declinedOffers: ["Quer que eu continue?"] };
		await saveAgentConversationState(a, "conv-1", state);
		assert.deepEqual(await getAgentConversationState(a, "conv-1"), state);
		assert.deepEqual(await getAgentConversationState(b, "conv-1"), { offers: [], declinedOffers: [] });
		await saveAgentConversationState(b, "conv-1", { offers: [{ cardId: "c1", label: "B", state: "open" }], declinedOffers: [] });
		assert.deepEqual(await getAgentConversationState(a, "conv-1"), state, "gravar a conversa de B não mexe na de A");
		await saveAgentConversationState(a, "conv-1", { offers: [], declinedOffers: [] });
		assert.deepEqual(await getAgentConversationState(a, "conv-1"), { offers: [], declinedOffers: [] });
		assert.equal((await getAgentConversationState(b, "conv-1")).offers.length, 1);
		await assert.rejects(saveAgentConversationState("default", "conv-1", state), ResourceOwnershipError);
	});

	test("conversa: mantém só as 50 ofertas mais recentes", async () => {
		const offers = Array.from({ length: 60 }, (_, i) => ({ cardId: `k${i}`, label: `L${i}`, state: "open" as const }));
		await saveAgentConversationState(a, "conv-2", { offers, declinedOffers: [] });
		const got = await getAgentConversationState(a, "conv-2");
		assert.equal(got.offers.length, 50);
		assert.equal(got.offers[0]?.cardId, "k10");
		assert.equal(got.offers.at(-1)?.cardId, "k59");
	});

	test("declinedOffers (B16): mantém a ordem de inserção entre gravações e não recria o que já existe", async () => {
		const conv = "conv-order";
		await saveAgentConversationState(a, conv, { offers: [], declinedOffers: ["zeta", "alfa", "meio"] });
		assert.deepEqual((await getAgentConversationState(a, conv)).declinedOffers, ["zeta", "alfa", "meio"]);
		const before = await prisma.agentConversationDeclined.findMany({ where: { userId: a, conversationId: conv }, orderBy: { label: "asc" } });
		await saveAgentConversationState(a, conv, { offers: [], declinedOffers: ["zeta", "alfa", "meio", "novo"] });
		assert.deepEqual((await getAgentConversationState(a, conv)).declinedOffers, ["zeta", "alfa", "meio", "novo"]);
		const after = await prisma.agentConversationDeclined.findMany({ where: { userId: a, conversationId: conv, label: { in: ["zeta", "alfa", "meio"] } }, orderBy: { label: "asc" } });
		assert.deepEqual(after.map((r) => r.createdAt.getTime()), before.map((r) => r.createdAt.getTime()), "createdAt original preservado (sem delete+recreate)");
		await saveAgentConversationState(a, conv, { offers: [], declinedOffers: ["alfa", "novo"] });
		assert.deepEqual((await getAgentConversationState(a, conv)).declinedOffers, ["alfa", "novo"]);
	});

	test("declinedOffers (B16): gravações simultâneas não corrompem nem falham, e o resultado é uma das listas inteiras", async () => {
		const conv = "conv-race";
		const lists = Array.from({ length: 6 }, (_, i) => Array.from({ length: 5 }, (_, j) => `r${i}-${j}`));
		await Promise.all(lists.map((declinedOffers) => saveAgentConversationState(a, conv, { offers: [{ cardId: "c", label: "L", state: "open" }], declinedOffers })));
		const final = (await getAgentConversationState(a, conv)).declinedOffers;
		assert.ok(lists.some((l) => JSON.stringify(l) === JSON.stringify(final)), `lista final inconsistente: ${final.join(",")}`);
		assert.equal((await getAgentConversationState(a, conv)).offers.length, 1);
	});

	test("C5: hasAgentV4Checkpoint responde sem trazer o payload; outro dono, run novo e v2 dão false; checkpoint legado sem a coluna dá true", async () => {
		const run = await prisma.agentRun.create({ data: { userId: a, objective: "o", model: "m", status: "queued" } });
		assert.equal(await hasAgentV4Checkpoint(a, run.id), false);
		await saveAgentV4CheckpointUnfenced(a, { runId: run.id, userId: a, step: 0, state: "PREPARE", payload: { v: 1, provenance: { untrustedReadInRun: false, privateReadInRun: false, sources: [], texts: [] } } });
		assert.equal(await hasAgentV4Checkpoint(a, run.id), true);
		assert.equal(await hasAgentV4Checkpoint(b, run.id), false, "outro dono não vê");
		const v2 = await prisma.agentRun.create({ data: { userId: a, objective: "o", model: "m", status: "queued", checkpointJson: { llmMessages: [] } } });
		assert.equal(await hasAgentV4Checkpoint(a, v2.id), false);
		const legacy = await prisma.agentRun.create({ data: { userId: a, objective: "o", model: "m", status: "paused", checkpointJson: { v4: { step: 1, state: "PARKED", payload: { v: 1 } } } } });
		assert.equal(await hasAgentV4Checkpoint(a, legacy.id), true);
		assert.equal(await hasAgentV4Checkpoint("default", run.id), false);
	});

	test("checkpoint: grava em checkpointJson.v4 sem apagar as chaves do v2; B não lê nem grava", async () => {
		await saveAgentV4CheckpointUnfenced(a, { runId: runA, userId: a, step: 2, state: "TOOLS", payload: { v: 1, messages: ["oi"] } });
		assert.deepEqual(await loadAgentV4Checkpoint(a, runA), { runId: runA, userId: a, step: 2, state: "TOOLS", payload: { v: 1, messages: ["oi"] } });
		const raw = await prisma.agentRun.findUniqueOrThrow({ where: { id: runA }, select: { checkpointJson: true } });
		assert.equal((raw.checkpointJson as { keep?: string }).keep, "v2");
		assert.equal(await loadAgentV4Checkpoint(b, runA), null);
		await assert.rejects(saveAgentV4CheckpointUnfenced(b, { runId: runA, userId: b, step: 9, state: "DONE", payload: {} }), ResourceOwnershipError);
		assert.equal((await loadAgentV4Checkpoint(a, runA))?.step, 2);
	});

	test("checkpoint: com lease só grava enquanto o lease é o desta execução", async () => {
		const run = await prisma.agentRun.create({ data: { userId: a, objective: "o", model: "m", status: "running", leaseOwner: "w1", leaseToken: "t1", leaseUntil: new Date(Date.now() + 60_000) } });
		const cp = { runId: run.id, userId: a, step: 1, state: "PREPARE", payload: {} };
		await saveAgentV4Checkpoint(a, cp, { owner: "w1", token: "t1" });
		await assert.rejects(saveAgentV4Checkpoint(a, cp, { owner: "w2", token: "t1" }), /lease_lost/);
		await prisma.agentRun.update({ where: { id: run.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
		await assert.rejects(saveAgentV4Checkpoint(a, cp, { owner: "w1", token: "t1" }), /lease_lost/);
	});

	test("checkpoint (S10): sem lease não grava (nem null, nem undefined) e não toca o que já estava salvo", async () => {
		const before = await loadAgentV4Checkpoint(a, runA);
		const cp = { runId: runA, userId: a, step: 99, state: "DONE", payload: { zumbi: true } };
		await assert.rejects(saveAgentV4Checkpoint(a, cp, null), /lease_required/);
		await assert.rejects(saveAgentV4Checkpoint(a, cp, undefined), /lease_required/);
		assert.deepEqual(await loadAgentV4Checkpoint(a, runA), before);
	});

	test("nota (S10): botId e sourceRunId precisam ser do mesmo dono", async () => {
		const botA = await createTestBot(a);
		const botB = await createTestBot(b);
		const runB = (await prisma.agentRun.create({ data: { userId: b, objective: "o", model: "m", status: "running" } })).id;
		await saveAgentNote({ id: "vinc", userId: a, title: "T", body: "b", pinned: false, botId: botA.id, sourceRunId: runA });
		assert.equal((await getAgentNote(a, "vinc"))?.botId, botA.id);
		await assert.rejects(saveAgentNote({ id: "vinc2", userId: a, title: "T", body: "b", pinned: false, botId: botB.id }), ResourceOwnershipError);
		await assert.rejects(saveAgentNote({ id: "vinc3", userId: a, title: "T", body: "b", pinned: false, sourceRunId: runB }), ResourceOwnershipError);
		assert.equal(await getAgentNote(a, "vinc2"), null);
		assert.equal(await getAgentNote(a, "vinc3"), null);
	});
});
