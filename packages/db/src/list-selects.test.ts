/**
 * Listagens sem as colunas grandes: bots sem o JSON da limpeza de memória/autonomia. Prisma interceptado;
 * sem banco.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { listBots } = await import("./bots.js");

const restores: Array<() => void> = [];
function stub(target: object, name: string, value: unknown) {
	const original = Reflect.get(target, name);
	Object.assign(target, { [name]: value });
	restores.push(() => Object.assign(target, { [name]: original }));
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});

test("listBots seleciona só o que o card do bot mostra (sem memoryCleanupJson/autonomyJson)", async () => {
	let args: { where?: unknown; select?: Record<string, boolean> } | undefined;
	stub(prisma.bot, "findMany", async (input: typeof args) => {
		args = input;
		throw new Error("parou aqui");
	});
	await assert.rejects(() => listBots("user-a"), /parou aqui/);
	assert.deepEqual(args?.where, { ownerId: { in: ["user-a"] } });
	assert.ok(args?.select);
	for (const big of ["memoryCleanupJson", "autonomyJson", "memoryCleanupError"]) assert.equal(big in args!.select!, false, big);
	assert.equal(args!.select!.policyJson, true);
});
