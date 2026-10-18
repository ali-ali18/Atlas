/**
 * Identidade das escritas no GitHub (preferência e assinatura) contra Postgres real.
 * Pulado sem ATLAS_TEST_DB_URL. Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getGithubWriteSettings, normalizeGithubSignatureText, saveGithubWriteSettings } from "./github-app.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

describe("preferência de escrita no GitHub (Postgres real)", { skip: dbSkip }, () => {
	test("padrão: sem escolha, assinatura desligada; salva e relê; usuários isolados", async () => {
		const a = (await createTestUser("ghw-a")).id;
		const b = (await createTestUser("ghw-b")).id;
		assert.deepEqual(await getGithubWriteSettings(a), { signature: false, signatureText: null });
		await saveGithubWriteSettings(a, { signature: true, signatureText: "  enviado   pelo bot Cookie " });
		assert.deepEqual(await getGithubWriteSettings(a), { signature: true, signatureText: "enviado pelo bot Cookie" });
		assert.deepEqual(await getGithubWriteSettings(b), { signature: false, signatureText: null });
		await saveGithubWriteSettings(a, { signature: false });
		const after = await getGithubWriteSettings(a);
		assert.equal(after.signature, false);
		assert.equal(after.signatureText, "enviado pelo bot Cookie");
	});
});

test("texto da assinatura: limpa controle, comprime espaços e limita o tamanho", () => {
	assert.equal(normalizeGithubSignatureText(" a\u0007  b "), "a b");
	assert.equal(normalizeGithubSignatureText("   "), null);
	assert.equal(normalizeGithubSignatureText(42), null);
	assert.equal(normalizeGithubSignatureText("x".repeat(500))?.length, 120);
});
