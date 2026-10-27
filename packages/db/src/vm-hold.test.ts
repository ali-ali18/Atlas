/** Run esperando o usuário segura a VM; escopo por dono. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { conversationHoldsVm } from "./vm-hold.js";

const NOW = new Date("2026-10-27T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
let installed: { restore: () => void };

beforeEach(() => {
	installed = installFakes({
		agentRun: new FakeTable([
			{ id: "r1", userId: "user-a", conversationId: "conv-login", status: "paused", updatedAt: hoursAgo(1) },
			{ id: "r2", userId: "user-a", conversationId: "conv-ask", status: "waiting_user", updatedAt: hoursAgo(2) },
			{ id: "r3", userId: "user-a", conversationId: "conv-old", status: "paused", updatedAt: hoursAgo(30) },
			{ id: "r4", userId: "user-a", conversationId: "conv-done", status: "completed", updatedAt: hoursAgo(1) },
		]),
	});
});
afterEach(() => installed.restore());

test("run pausado no login ou esperando o usuário segura a VM; concluído ou muito antigo, não", async () => {
	assert.equal(await conversationHoldsVm("user-a", "conv-login", NOW), true);
	assert.equal(await conversationHoldsVm("user-a", "conv-ask", NOW), true);
	assert.equal(await conversationHoldsVm("user-a", "conv-old", NOW), false);
	assert.equal(await conversationHoldsVm("user-a", "conv-done", NOW), false);
});

test("usuário B não segura (nem enxerga) a VM da conversa do usuário A", async () => {
	assert.equal(await conversationHoldsVm("user-b", "conv-login", NOW), false);
	assert.equal(await conversationHoldsVm("default", "conv-login", NOW), false);
});
