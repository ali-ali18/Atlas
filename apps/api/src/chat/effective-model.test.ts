import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const { resolveRunModel } = await import("./effective-model.js");

const envDefault = "openai/gpt-6-luna";
// Sem conta configurada: evita a consulta real ao db (DATABASE_URL ausente em teste).
const noAccountConfig = async () => ({ v: 1 as const });

test("resposta de questionário (sem model) usa o modelo do bot, não o do .env", async () => {
	const model = await resolveRunModel({
		botId: "bot-1",
		userId: "user-a",
		envDefault,
		getAccountConfig: noAccountConfig,
		getBotModel: async (botId, userId) =>
			botId === "bot-1" && userId === "user-a" ? "anthropic/claude-sonnet-5.5" : null,
	});
	assert.equal(model, "anthropic/claude-sonnet-5.5");
});

test("model explícito do composer vence o do bot e nem consulta o db", async () => {
	const model = await resolveRunModel({
		requested: "x/y",
		botId: "bot-1",
		userId: "user-a",
		envDefault,
		getBotModel: async () => {
			throw new Error("não deveria consultar");
		},
	});
	assert.equal(model, "x/y");
});

test("bot de outro usuário não empresta o modelo (helper devolve null) e cai no .env", async () => {
	const model = await resolveRunModel({
		botId: "bot-1",
		userId: "user-b",
		envDefault,
		getAccountConfig: noAccountConfig,
		getBotModel: async (_b, userId) => (userId === "user-a" ? "m/a" : null),
	});
	assert.equal(model, envDefault);
});
