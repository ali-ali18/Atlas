import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { prisma } from "./client.js";
import { setBotReasoningEffort } from "./bots.js";

const original = Reflect.get(prisma, "$transaction");
afterEach(() => {
	Object.assign(prisma, { $transaction: original });
	mock.restoreAll();
});

function stubTransaction(rows: Array<{ policyJson: unknown }>) {
	const updates: unknown[] = [];
	const tx = {
		$queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
			// o dono vem da sessão e entra na consulta (FOR UPDATE por id + ownerId)
			assert.deepEqual(values, ["bot-a", "user-a"]);
			return rows;
		},
		bot: { update: async (args: unknown) => { updates.push(args); return {}; } },
	};
	Object.assign(prisma, { $transaction: async (callback: (t: unknown) => unknown) => callback(tx) });
	return updates;
}

test("grava o nível preservando as outras chaves da política", async () => {
	const updates = stubTransaction([{ policyJson: { engine: "v2" } }]);
	assert.equal(await setBotReasoningEffort("bot-a", "user-a", "low"), true);
	assert.deepEqual((updates[0] as { data: { policyJson: unknown } }).data.policyJson, { engine: "v2", reasoningEffort: "low" });
});

test("null remove só o nível", async () => {
	const updates = stubTransaction([{ policyJson: { engine: "v2", reasoningEffort: "high" } }]);
	assert.equal(await setBotReasoningEffort("bot-a", "user-a", null), true);
	assert.deepEqual((updates[0] as { data: { policyJson: unknown } }).data.policyJson, { engine: "v2" });
});

test("bot de outro dono (consulta sem linha) devolve false e não grava", async () => {
	const updates = stubTransaction([]);
	assert.equal(await setBotReasoningEffort("bot-a", "user-a", "low"), false);
	assert.equal(updates.length, 0);
});
