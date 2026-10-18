import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prisma } from "./client.js";
import {
	getProviderConnection,
	updateProviderConnection,
	withProviderRefreshLock,
} from "./provider-connections.js";
const restores: Array<() => void> = [];
function stub(target: object, key: string, value: unknown) {
	const old = Reflect.get(target, key);
	Reflect.set(target, key, value);
	restores.push(() => Reflect.set(target, key, old));
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});
test("B não lê nem atualiza conexão de A", async () => {
	const calls: unknown[] = [];
	stub(
		prisma.providerConnection,
		"findFirst",
		async (query: { where: { userId: string; provider: string } }) => {
			calls.push(query);
			return query.where.userId === "a" ? { userId: "a" } : null;
		},
	);
	stub(
		prisma.providerConnection,
		"updateMany",
		async (query: { where: { userId: string; provider: string } }) => {
			calls.push(query);
			return { count: query.where.userId === "a" ? 1 : 0 };
		},
	);
	assert.equal(await getProviderConnection("b"), null);
	assert.equal(
		await updateProviderConnection("b", "chatgpt", { status: "disconnected" }),
		false,
	);
	assert.ok(
		calls.every((query) => JSON.stringify(query).includes('"userId":"b"')),
	);
});
test("lock Postgres parametrizado precede criação e releitura escopada", async () => {
	const sequence: string[] = [];
	const tx = {
		// pg_advisory_xact_lock retorna void: $queryRaw falharia ao desserializar.
		$queryRaw: async () => {
			assert.fail("lock não pode usar $queryRaw (retorno void)");
		},
		$executeRaw: async (strings: TemplateStringsArray, key: string) => {
			sequence.push("lock");
			assert.equal(key, "provider-refresh:a:chatgpt");
			assert.match(strings.join(""), /pg_advisory_xact_lock/);
		},
		providerConnection: {
			upsert: async (query: {
				where: { userId_provider: { userId: string } };
			}) => {
				assert.equal(query.where.userId_provider.userId, "a");
				sequence.push("upsert");
			},
			findFirst: async (query: { where: { userId: string } }) => {
				assert.equal(query.where.userId, "a");
				sequence.push("read");
				return null;
			},
			updateMany: async (query: { where: { userId: string } }) => {
				assert.equal(query.where.userId, "a");
				sequence.push("update");
				return { count: 1 };
			},
		},
	};
	stub(
		prisma,
		"$transaction",
		async (operation: (tx: object) => Promise<unknown>) => {
			const result = await operation(tx);
			sequence.push("commit");
			return result;
		},
	);
	await withProviderRefreshLock("a", "chatgpt", async (locked) => {
		await locked.get();
		await locked.update({ status: "needs_login" });
		return "fatal-sentinel";
	});
	assert.deepEqual(sequence, ["lock", "upsert", "read", "update", "commit"]);
});
