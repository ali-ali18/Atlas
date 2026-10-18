import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { prisma } from "./client.js";
import { appendUserSecretAudit, deleteUserSecretRow, getUserSecretById, getUserSecretByName, listUserSecretAudit, listUserSecrets, updateUserSecretRow } from "./user-secrets.js";

const restores: Array<() => void> = [];
function stubMethod<F extends (...args: never[]) => unknown>(target: object, name: string, implementation: F) {
	const original = Reflect.get(target, name);
	const replacement = mock.fn(implementation);
	Object.assign(target, { [name]: replacement });
	restores.push(() => Object.assign(target, { [name]: original }));
	return replacement;
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	mock.restoreAll();
});

type Where = { id?: string; userId?: string; name?: string; secretId?: string };
const rows = [
	{ id: "s1", userId: "alice", name: "tok", kind: "secret" },
	{ id: "s2", userId: "bob", name: "tok", kind: "secret" },
];
const match = (where: Where) => rows.filter((row) => (where.id === undefined || row.id === where.id) && (where.userId === undefined || row.userId === where.userId) && (where.name === undefined || row.name === where.name));

test("toda consulta do cofre filtra pelo dono: o item de outro usuário não existe", async () => {
	const findFirst = stubMethod(prisma.userSecret, "findFirst", async (args: { where: Where }) => match(args.where)[0] ?? null);
	const findMany = stubMethod(prisma.userSecret, "findMany", async (args: { where: Where }) => match(args.where));
	const updateMany = stubMethod(prisma.userSecret, "updateMany", async (args: { where: Where }) => ({ count: match(args.where).length }));
	const deleteMany = stubMethod(prisma.userSecret, "deleteMany", async (args: { where: Where }) => ({ count: match(args.where).length }));
	assert.equal(await getUserSecretById("alice", "s2"), null);
	assert.equal((await getUserSecretById("alice", "s1"))?.id, "s1");
	assert.equal((await getUserSecretByName("bob", "tok"))?.id, "s2");
	assert.deepEqual((await listUserSecrets("alice")).map((row) => row.id), ["s1"]);
	assert.equal(await deleteUserSecretRow("alice", "s2"), false);
	assert.equal(await deleteUserSecretRow("alice", "s1"), true);
	assert.equal(await updateUserSecretRow("bob", "s1", { label: "x" }), null);
	for (const call of [...findFirst.mock.calls, ...findMany.mock.calls, ...updateMany.mock.calls, ...deleteMany.mock.calls]) {
		assert.ok(call.arguments[0]?.where.userId, "where sem userId");
	}
});

test("auditoria: só grava em item do dono e só lê do dono", async () => {
	stubMethod(prisma.userSecret, "findFirst", async (args: { where: Where }) => match(args.where)[0] ?? null);
	const create = stubMethod(prisma.userSecretAudit, "create", async (_args: { data: { userId: string } }) => ({}));
	const findMany = stubMethod(prisma.userSecretAudit, "findMany", async (_args: { where: Where }) => []);
	await appendUserSecretAudit("alice", "s2", { action: "revealed" });
	assert.equal(create.mock.callCount(), 0);
	await appendUserSecretAudit("alice", "s1", { action: "used", actor: "bot", botId: "b1", botName: "Ana", conversationId: "c1" });
	assert.equal(create.mock.callCount(), 1);
	assert.equal(create.mock.calls[0]?.arguments[0]?.data.userId, "alice");
	await listUserSecretAudit("alice", "s1");
	assert.deepEqual(findMany.mock.calls[0]?.arguments[0]?.where, { secretId: "s1", userId: "alice" });
});
