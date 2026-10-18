/**
 * Conexões de API (OpenAPI) contra Postgres real: criação, catálogo, state de uso único e
 * isolamento por dono. Pulado sem ATLAS_TEST_DB_URL. Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	claimApiConnectionByStateHash,
	createApiConnection,
	deleteApiConnection,
	getApiConnection,
	getApiConnectionWithCatalog,
	listApiConnections,
	toApiConnectionView,
	updateApiConnection,
} from "./api-connections.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

const catalog = [{ id: "getProdutos", method: "GET" as const, path: "/produtos", summary: "Lista", tag: "Produtos", params: [], body: false }];
const groups = [{ tag: "Produtos", total: 1, read: 1, write: 0 }];

describe("conexões de API (Postgres real)", { skip: dbSkip }, () => {
	test("cria, lê com catálogo e nunca expõe segredo na visão; outro dono não alcança nada", async () => {
		const a = (await createTestUser("api-a")).id;
		const b = (await createTestUser("api-b")).id;
		const created = await createApiConnection({
			userId: a, slug: "bling", name: "Bling", baseUrl: "https://api.bling.test/v3", specUrl: "https://d.bling.test/openapi.json",
			auth: { kind: "oauth2", authorizeUrl: "https://x.test/a", tokenUrl: "https://x.test/t" }, catalog, groups, allowedTags: ["Produtos"], secretsEnc: "v1:sealed",
		});
		assert.equal(created.status, "pending_auth");
		assert.equal(created.domain, "api.bling.test");
		assert.ok(!JSON.stringify(toApiConnectionView(created)).includes("sealed"));
		// Mesmo slug gera sufixo para o mesmo dono.
		const second = await createApiConnection({ userId: a, slug: "bling", name: "Bling 2", baseUrl: "https://api.outro.test", specUrl: "https://o.test/s.json", auth: { kind: "none" }, catalog, groups, allowedTags: [] });
		assert.equal(second.slug, "bling-2");

		const full = await getApiConnectionWithCatalog(created.id, a);
		assert.equal(full?.catalog[0]?.id, "getProdutos");
		assert.equal(await getApiConnectionWithCatalog(created.id, b), null);
		assert.equal(await getApiConnection(created.id, b), null);
		assert.deepEqual(await listApiConnections(b), []);
		assert.equal(await updateApiConnection(created.id, { name: "Hack" }, b), null);
		assert.equal(await deleteApiConnection(created.id, b), false);
		assert.equal((await getApiConnection(created.id, a))?.name, "Bling");
		assert.equal(await deleteApiConnection(created.id, a), true);
	});

	test("state OAuth é de uso único e só vale para o dono", async () => {
		const a = (await createTestUser("api-state-a")).id;
		const b = (await createTestUser("api-state-b")).id;
		const row = await createApiConnection({ userId: a, slug: "s", name: "S", baseUrl: "https://api.s.test", specUrl: "https://s.test/o.json", auth: { kind: "none" }, catalog, groups, allowedTags: [] });
		await updateApiConnection(row.id, { oauthStateHash: "hash-api-1" }, a);
		assert.equal(await claimApiConnectionByStateHash("hash-api-1", b), null);
		assert.equal((await claimApiConnectionByStateHash("hash-api-1", a))?.id, row.id);
		assert.equal(await claimApiConnectionByStateHash("hash-api-1", a), null);
	});
});
