import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { SUPERSEDED_CARD_DETAIL } from "@workspace/shared";
import { listConversationMessages } from "./conversations.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let installed: { restore: () => void };
let intents: FakeTable;
const old = new Date(Date.now() - 5 * 60_000);

function confirmRow(id: string, confirmId: string, status: string, createdAt = old) {
	return { id, conversationId: "c1", role: "confirm", content: JSON.stringify({ v: 1, kind: "confirm", confirmId, title: "Executar", status }), createdAt };
}

beforeEach(() => {
	intents = new FakeTable([]);
});
afterEach(() => installed.restore());

async function load(rows: ReturnType<typeof confirmRow>[]) {
	installed = installFakes({ conversationMessage: new FakeTable(rows), skillPendingIntent: intents });
	const list = await listConversationMessages("c1");
	return list.sort((a, b) => a.id.localeCompare(b.id)).map((m) => JSON.parse(m.content) as { status: string; outcome?: { detail: string } });
}

test("cartão pendente sem intenção viva volta expirado (não pede de novo ao reabrir)", async () => {
	const [card] = await load([confirmRow("m1", "k1", "pending")]);
	assert.equal(card!.status, "rejected");
	assert.equal(card!.outcome?.detail, SUPERSEDED_CARD_DETAIL);
});

test("intenção viva do mesmo cartão mantém pendente; de outro cartão expira o antigo", async () => {
	intents = new FakeTable([{ id: "i1", userId: "u1", conversationId: "c1", kind: "confirm", payload: { confirmId: "k2" }, expiresAt: new Date(Date.now() + 60_000) }]);
	const cards = await load([confirmRow("m1", "k1", "pending", new Date(old.getTime() - 1000)), confirmRow("m2", "k2", "pending")]);
	assert.deepEqual(cards.map((c) => c.status), ["rejected", "pending"]);
});

test("cartão recém-gravado e já decidido ficam como estão", async () => {
	const cards = await load([confirmRow("m1", "k1", "pending", new Date()), confirmRow("m2", "k2", "approved", new Date(Date.now() - 5000))]);
	assert.deepEqual(cards.map((c) => c.status), ["pending", "approved"]);
});
