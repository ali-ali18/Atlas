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

const { resolveRunModelChoice } = await import("./effective-model.js");
const noBot = async () => ({ model: null, policyJson: null });
const tiersAccount = async () => ({ v: 1 as const, models: { default: "acc/default" } });

test("Automático: sem escolha no composer nem modelo no bot, o modelo base é o padrão da conta e o worker escolhe o nível", async () => {
	const choice = await resolveRunModelChoice({ userId: "u", envDefault, getBotChoice: noBot, getAccountConfig: tiersAccount });
	assert.deepEqual(choice, { model: "acc/default", auto: true });
});

test("Automático: modelo explícito do composer fixa o modelo (sem consultar o bot)", async () => {
	const choice = await resolveRunModelChoice({
		requested: "x/y",
		botId: "bot-1",
		userId: "u",
		envDefault,
		getBotChoice: async () => {
			throw new Error("não deveria consultar");
		},
	});
	assert.deepEqual(choice, { model: "x/y", auto: false });
});

test("Automático: modelo do bot sem níveis próprios fixa o modelo, como sempre", async () => {
	const choice = await resolveRunModelChoice({
		botId: "bot-1",
		userId: "u",
		envDefault,
		getBotChoice: async () => ({ model: "bot/m", policyJson: {} }),
		getAccountConfig: tiersAccount,
	});
	assert.deepEqual(choice, { model: "bot/m", auto: false });
});

test("Automático: pedido do composer ('Automático') ignora o modelo do bot e usa o padrão da conta", async () => {
	const choice = await resolveRunModelChoice({
		requested: "stale/model",
		modelAuto: true,
		botId: "bot-1",
		userId: "u",
		envDefault,
		getBotChoice: async () => ({ model: "bot/m", policyJson: {} }),
		getAccountConfig: tiersAccount,
	});
	assert.deepEqual(choice, { model: "acc/default", auto: true });
});

test("Automático: bot com níveis próprios usa o modelo dele como base e roda no Automático", async () => {
	const choice = await resolveRunModelChoice({
		botId: "bot-1",
		userId: "u",
		envDefault,
		getBotChoice: async () => ({ model: "bot/m", policyJson: { modelTiers: { hard: ["h/m"] } } }),
		getAccountConfig: tiersAccount,
	});
	assert.deepEqual(choice, { model: "bot/m", auto: true });
});

test("Automático: falha ao ler a conta cai no .env", async () => {
	const choice = await resolveRunModelChoice({
		userId: "u",
		envDefault,
		getBotChoice: noBot,
		getAccountConfig: async () => {
			throw new Error("db fora");
		},
	});
	assert.deepEqual(choice, { model: envDefault, auto: true });
});

// App mobile: o pedido só leva `modelAuto` quando a pessoa escolheu "Automático" (antes ia sempre, e o modelo do bot era ignorado).
test("sem modelAuto nem modelo no pedido, o modelo fixo do bot vence o padrão da conta (o caso do app sem escolha)", async () => {
	const choice = await resolveRunModelChoice({
		requested: undefined,
		modelAuto: undefined,
		botId: "bot-1",
		userId: "u",
		envDefault,
		getBotChoice: async (botId, userId) => (botId === "bot-1" && userId === "u" ? { model: "bot/m", policyJson: {} } : { model: null, policyJson: null }),
		getAccountConfig: tiersAccount,
	});
	assert.deepEqual(choice, { model: "bot/m", auto: false });
});

test("modelo explícito do pedido vence o modelo fixo do bot (o app com modelo escolhido, sem modelAuto)", async () => {
	const choice = await resolveRunModelChoice({
		requested: "escolhido/m",
		botId: "bot-1",
		userId: "u",
		envDefault,
		getBotChoice: async () => ({ model: "bot/m", policyJson: {} }),
		getAccountConfig: tiersAccount,
	});
	assert.deepEqual(choice, { model: "escolhido/m", auto: false });
});
