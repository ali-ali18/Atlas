import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { loadEffectiveConfig } = await import("./account-config.js");
const { buildJevIntentFor } = await import("./jev-intent.js");
const { resolveRunModel } = await import("./effective-model.js");

const configs: Record<string, unknown> = {
	"user-a": { v: 1, models: { default: "a/modelo", image: "a/imagem" }, jev: { features: { intent: "on" } } },
};
// Lê só pelo userId pedido: B nunca enxerga o config de A.
const load = async (userId: string) => (configs[userId] ?? { v: 1 }) as never;
const noKeys = { loadConfig: load, hasKey: async () => false, record: async () => undefined };

test("loadEffectiveConfig: usuário > env > padrão, escopado pelo userId", async () => {
	const env = { OPENROUTER_MODEL: "env/modelo", ATLAS_IMAGE_MODEL: "env/imagem" };
	const a = await loadEffectiveConfig("user-a", env, load);
	assert.deepEqual(a.models.default, { value: "a/modelo", source: "user" });
	assert.deepEqual(a.models.image, { value: "a/imagem", source: "user" });
	const b = await loadEffectiveConfig("user-b", env, load);
	assert.deepEqual(b.models.default, { value: "env/modelo", source: "env" });
	assert.deepEqual(b.models.image, { value: "env/imagem", source: "env" });
});

test("loadEffectiveConfig: falha ao ler cai no env/padrão sem lançar", async () => {
	const original = console.error;
	console.error = () => {};
	try {
		const effective = await loadEffectiveConfig("user-a", { OPENROUTER_MODEL: "env/modelo" }, async () => {
			throw new Error("postgres://segredo@host/db");
		});
		assert.deepEqual(effective.models.default, { value: "env/modelo", source: "env" });
	} finally {
		console.error = original;
	}
});

test("sem config do usuário nada muda: Jev de intenção segue o env", async () => {
	assert.equal(await buildJevIntentFor("user-b", "key", {}, load), undefined);
	assert.equal(await buildJevIntentFor("user-b", undefined, { JEV_INTENT_MODE: "on" }, load, noKeys), undefined);
	assert.ok(await buildJevIntentFor("user-b", "key", { JEV_INTENT_MODE: "on" }, load, noKeys));
});

test("Jev de intenção liga pelo config do usuário mesmo com env off, só para ele", async () => {
	assert.ok(await buildJevIntentFor("user-a", "key", { JEV_INTENT_MODE: "off" }, load));
	assert.equal(await buildJevIntentFor("user-b", "key", { JEV_INTENT_MODE: "off" }, load), undefined);
});

test("resolveRunModel: composer > bot > padrão da conta > .env", async () => {
	const base = { botId: "bot-1", envDefault: "env/modelo", getAccountConfig: load };
	assert.equal(await resolveRunModel({ ...base, userId: "user-a", getBotModel: async () => null }), "a/modelo");
	assert.equal(await resolveRunModel({ ...base, userId: "user-a", getBotModel: async () => "bot/modelo" }), "bot/modelo");
	assert.equal(await resolveRunModel({ ...base, userId: "user-a", requested: "x/y", getBotModel: async () => null }), "x/y");
	// Outro usuário não herda o padrão de A.
	assert.equal(await resolveRunModel({ ...base, userId: "user-b", getBotModel: async () => null }), "env/modelo");
	// Falha na conta cai no .env.
	assert.equal(
		await resolveRunModel({ ...base, userId: "user-a", getBotModel: async () => null, getAccountConfig: async () => { throw new Error("x"); } }),
		"env/modelo",
	);
});

test("Jev de intenção sem chave do servidor usa a chave Anthropic da conta (revisor pela manutenção)", async () => {
	const withAnthropic = { ...noKeys, loadConfig: (async () => ({ v: 1, models: { reviewer: "anthropic-direct/claude-haiku" } })) as never, hasKey: async (_user: string, provider: string) => provider === "anthropic" };
	assert.ok(await buildJevIntentFor("user-b", undefined, { JEV_INTENT_MODE: "on" }, load, withAnthropic));
	// Sem modelo escolhido e sem chave do servidor não há o que chamar: Jev indisponível.
	assert.equal(await buildJevIntentFor("user-b", undefined, { JEV_INTENT_MODE: "on" }, load, { ...noKeys, hasKey: async (_u: string, p: string) => p === "anthropic" }), undefined);
});
