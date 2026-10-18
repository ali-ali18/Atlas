/** Cofre contra Postgres real: migration aplicada, isolamento por dono, unicidade de nome, auditoria, cascata e sem segredo nos eventos do hub. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";
import { appendUserSecretAudit, createUserSecretRow, createUserVaultKey, deleteUserSecretRow, deleteUserVault, getUserSecretById, getUserVaultKey, listUserSecretAudit, listUserSecrets } from "./user-secrets.js";

describe("cofre (Postgres real)", { skip: dbSkip }, () => {
	let a: string;
	let b: string;
	before(async () => {
		a = (await createTestUser("vault-a")).id;
		b = (await createTestUser("vault-b")).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("isolamento por dono, nome único por usuário, auditoria e apagar em cascata", async () => {
		const SECRET = "ENC:valor-sensivel-xyz";
		await createUserVaultKey(a, "wrapped-a");
		assert.equal(await getUserVaultKey(a), "wrapped-a");
		const s = await createUserSecretRow(a, { id: `s-${a}`, kind: "secret", name: "tok", valueEnc: SECRET });
		await assert.rejects(createUserSecretRow(a, { id: `s2-${a}`, kind: "secret", name: "tok", valueEnc: SECRET }));
		await createUserSecretRow(b, { id: `s-${b}`, kind: "secret", name: "tok", valueEnc: "ENC:outro" });
		assert.equal(await getUserSecretById(b, s.id), null, "outro usuário não enxerga o item");
		const metas = await listUserSecrets(a);
		assert.equal(metas.length, 1);
		assert.ok(!JSON.stringify(metas).includes(SECRET), "lista não devolve o valor cifrado");
		await appendUserSecretAudit(a, s.id, { action: "revealed", actor: "user" });
		assert.equal((await listUserSecretAudit(a, s.id)).length, 1);
		assert.equal(await deleteUserSecretRow(b, s.id), false);
		assert.equal(await deleteUserSecretRow(a, s.id), true);
		assert.equal(await prisma.userSecretAudit.count({ where: { secretId: s.id } }), 0, "auditoria some junto");
		await deleteUserVault(a);
		assert.equal(await getUserVaultKey(a), null);
	});

	test("nenhum evento do hub carrega valor de segredo", async () => {
		const events = await prisma.userEvent.findMany({ where: { userId: { in: [a, b] } } });
		assert.ok(!JSON.stringify(events).includes("ENC:"));
	});
});
