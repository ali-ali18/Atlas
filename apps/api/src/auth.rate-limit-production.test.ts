/** Sem `deps.rateLimit`, o limite do better-auth segue ligado em produção (e desligado fora dela). */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL = "owner@example.test";
process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret";
process.env.ATLAS_URL = "https://atlas.example.test";
process.env.NODE_ENV = "production";

// Import dinâmico depois de ajustar o ambiente: o better-auth lê NODE_ENV ao carregar.
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { createAuth } = await import("./auth.js");

test("rate limit ligado por padrão em produção", async () => {
	const auth = createAuth({ database: memoryAdapter({ user: [], session: [], account: [], verification: [], rateLimit: [] }), mail: async () => {} });
	const context = await auth.$context;
	assert.equal(context.rateLimit.enabled, true);
});
