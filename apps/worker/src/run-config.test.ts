import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBudget } from "@workspace/agent-runtime";
import type { AccountConfigV1, AgentRunCheckpoint } from "@workspace/shared";
import { loadWorkerConfig, parseJevModes } from "./config.js";
import {
	effectiveCostCapUsd,
	runtimeBudgetParams,
	HISTORY_LIMIT_ECONOMY,
	HISTORY_LIMIT_STANDARD,
	accountBudgetPolicy,
	appendObjective,
	historyWindowFor,
	resolveDefaultModelForJob,
	resolveMaintenanceModelForJob,
	resolveRunCodingModel,
	resolveRunModelTiers,
	resolveRunConfigSnapshot,
	runtimeParamsFromSnapshot,
	visionFallbackFromSnapshot,
	withConfigSnapshot,
} from "./run-config.js";

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";

const configs: Record<string, AccountConfigV1> = {
	[USER_A]: {
		v: 1,
		models: { default: "a/default", fallbacks: ["a/fb"], vision: "a/see", image: "a/gen", maintenance: "a/maint" },
		jev: { mcp: "gate", all: "shadow", features: { intent: "on" } },
		execution: { discipline: false, contextEconomy: false, llmTimeoutPreset: "extended", maxOutputTokens: 16384, maxSteps: 100, maxWallMinutes: 5 },
	},
};
const load = async (userId: string): Promise<AccountConfigV1> => configs[userId] ?? { v: 1 };
const frozen = (env: Record<string, string>) => Object.freeze({ ...env });

test("sem config do usuário o snapshot é o que o worker lia do env no boot", async () => {
	const envs: Array<Record<string, string>> = [
		{},
		{ JEV_MCP_MODE: "gate", JEV_INTENT_MODE: "on", JEV_TOOLS_MODE: "shadow", JEV_STUCK_MODE: "bogus" },
		{ JEV_MCP_MODE: "banana" },
		{ LLM_MAX_OUTPUT_TOKENS: "6000", LLM_DECISION_TIMEOUT_MS: "70000", OPENROUTER_FALLBACK_MODELS: "x/y, z/w", ATLAS_IMAGE_MODEL: "i/m" },
		{ ATLAS_EXECUTION_DISCIPLINE: "off" },
		{ ATLAS_CONTEXT_ECONOMY: "off" },
	];
	// `loadWorkerConfig` lê o process.env; só as chaves envolvidas são trocadas e restauradas.
	const keys = ["JEV_MCP_MODE", "JEV_INTENT_MODE", "JEV_TOOLS_MODE", "JEV_VERIFY_MODE", "JEV_BLOCKPAGE_MODE", "JEV_DELEGATE_MODE", "JEV_STUCK_MODE"];
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	try {
		for (const env of envs) {
			for (const key of keys) delete process.env[key];
			Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([key]) => keys.includes(key))));
			const boot = loadWorkerConfig();
			const { snapshot, reused } = await resolveRunConfigSnapshot(
				{ userId: USER_B, sandboxAutoStart: true },
				{ env: frozen(env), loadConfig: async () => ({ v: 1 }) },
			);
			assert.equal(reused, false);
			assert.equal(snapshot.jevMcpMode, boot.jevMcpMode);
			assert.deepEqual(snapshot.jevModes, boot.jevModes);
			assert.deepEqual(snapshot.jevModes, parseJevModes(env));
			assert.equal(snapshot.executionDiscipline, env.ATLAS_EXECUTION_DISCIPLINE !== "off");
			assert.equal(snapshot.contextEconomy, env.ATLAS_CONTEXT_ECONOMY !== "off");
			assert.equal(snapshot.maxOutputTokens, env.LLM_MAX_OUTPUT_TOKENS ? Number(env.LLM_MAX_OUTPUT_TOKENS) : undefined);
			assert.equal(snapshot.llmTimeouts.totalMs, env.LLM_DECISION_TIMEOUT_MS ? Number(env.LLM_DECISION_TIMEOUT_MS) : 90_000);
			assert.equal(snapshot.llmTimeouts.firstEventMs, 30_000);
			assert.equal(snapshot.llmTimeouts.idleMs, 20_000);
			assert.deepEqual(snapshot.fallbackModels, env.OPENROUTER_FALLBACK_MODELS ? ["x/y", "z/w"] : []);
			assert.equal(snapshot.imageModel, env.ATLAS_IMAGE_MODEL);
			assert.equal(snapshot.visionModel, undefined);
			assert.equal(snapshot.sandboxAutoStart, true);
		}
	} finally {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
});

test("sem config do usuário o orçamento e os parâmetros da lib ficam como hoje", async () => {
	const { snapshot } = await resolveRunConfigSnapshot({ userId: USER_B, sandboxAutoStart: true }, { env: {}, loadConfig: load });
	assert.deepEqual(accountBudgetPolicy(snapshot, 100), {});
	assert.deepEqual(resolveBudget({ maxSteps: 100, policy: accountBudgetPolicy(snapshot, 100) }), resolveBudget({ maxSteps: 100, policy: {} }));
	const params = runtimeParamsFromSnapshot(snapshot);
	assert.equal(params.maxOutputTokens, undefined);
	assert.equal(params.imageModel, undefined);
	assert.equal(params.executionDiscipline, true);
	assert.equal(params.contextEconomy, true);
	assert.equal(params.modelCallTimeoutMs, 90_000);
	assert.equal(visionFallbackFromSnapshot(snapshot), undefined);
});

test("memória da conversa: Padrão sem escolha, economy da conta chega nos parâmetros da lib", async () => {
	const none = await resolveRunConfigSnapshot({ userId: USER_B, sandboxAutoStart: true }, { env: {}, loadConfig: load });
	assert.equal(runtimeParamsFromSnapshot(none.snapshot).contextMemory, "standard");
	const economy = await resolveRunConfigSnapshot(
		{ userId: USER_B, sandboxAutoStart: true },
		{ env: {}, loadConfig: async () => ({ v: 1, execution: { contextMemory: "economy" } }) },
	);
	assert.equal(runtimeParamsFromSnapshot(economy.snapshot).contextMemory, "economy");
});

test("histórico entre turnos: Econômico mantém 40 (ou 6 com resumo fresco); Padrão carrega mais e nunca usa o ciclo limpo", () => {
	assert.deepEqual(historyWindowFor("economy", false), { compact: false, limit: HISTORY_LIMIT_ECONOMY });
	assert.deepEqual(historyWindowFor("economy", true), { compact: true, limit: HISTORY_LIMIT_ECONOMY });
	assert.equal(HISTORY_LIMIT_ECONOMY, 40);
	for (const memory of ["standard", undefined] as const) {
		for (const fresh of [false, true]) {
			assert.deepEqual(historyWindowFor(memory, fresh), { compact: false, limit: HISTORY_LIMIT_STANDARD });
		}
	}
	assert.ok(HISTORY_LIMIT_STANDARD > HISTORY_LIMIT_ECONOMY);
});

test("objetivo não repete a última fala do usuário já presente no histórico", () => {
	const history = [{ role: "assistant", content: "oi" }, { role: "user", content: "faça X" }];
	assert.deepEqual(appendObjective(history, "faça X"), history);
	assert.equal(appendObjective(history, "faça Y").length, 3);
	assert.deepEqual(appendObjective(history, "  "), history);
	assert.equal(appendObjective([{ role: "user", content: "faça X" }, { role: "assistant", content: "ok" }], "faça X").length, 3);
});

test("dois usuários no mesmo processo: cada run usa a configuração do seu dono", async () => {
	const env = frozen({ JEV_MCP_MODE: "shadow", OPENROUTER_FALLBACK_MODELS: "env/fb" });
	const [a, b] = await Promise.all([
		resolveRunConfigSnapshot({ userId: USER_A, sandboxAutoStart: false }, { env, loadConfig: load }),
		resolveRunConfigSnapshot({ userId: USER_B, sandboxAutoStart: true }, { env, loadConfig: load }),
	]);
	assert.equal(a.snapshot.jevMcpMode, "gate");
	assert.equal(a.snapshot.jevModes.tools, "shadow");
	assert.equal(a.snapshot.jevModes.intent, "on");
	assert.deepEqual(a.snapshot.fallbackModels, ["a/fb"]);
	assert.equal(a.snapshot.imageModel, "a/gen");
	assert.equal(a.snapshot.executionDiscipline, false);
	assert.equal(a.snapshot.contextEconomy, false);
	assert.equal(a.snapshot.maxOutputTokens, 16384);
	assert.deepEqual(a.snapshot.llmTimeouts, { totalMs: 180_000, firstEventMs: 60_000, idleMs: 40_000 });
	assert.equal(a.snapshot.sandboxAutoStart, false);
	// B não herda nada de A e fica no env do servidor.
	assert.equal(b.snapshot.jevMcpMode, "shadow");
	assert.deepEqual(b.snapshot.fallbackModels, ["env/fb"]);
	assert.equal(b.snapshot.imageModel, undefined);
	assert.equal(b.snapshot.executionDiscipline, true);
	assert.equal(b.snapshot.contextEconomy, true);
});

test("o loader recebe o userId do run e nenhum outro", async () => {
	const asked: string[] = [];
	await resolveRunConfigSnapshot({ userId: USER_B, sandboxAutoStart: true }, { env: {}, loadConfig: async (id) => { asked.push(id); return { v: 1 }; } });
	assert.deepEqual(asked, [USER_B]);
});

test("config alterada no meio do run não afeta o run; o próximo usa a nova", async () => {
	const live: Record<string, AccountConfigV1> = { [USER_A]: { v: 1, execution: { maxOutputTokens: 4096 } } };
	const loader = async (id: string) => live[id] ?? { v: 1 };
	const first = await resolveRunConfigSnapshot({ userId: USER_A, sandboxAutoStart: true }, { env: {}, loadConfig: loader });
	assert.equal(first.snapshot.maxOutputTokens, 4096);

	live[USER_A] = { v: 1, execution: { maxOutputTokens: 32768 }, models: { image: "novo/modelo" } };

	// Retomada (checkpoint gravado com o snapshot) reusa os valores congelados.
	const checkpoint = withConfigSnapshot({ version: 1, messages: [] } as AgentRunCheckpoint, first.snapshot);
	const restored = JSON.parse(JSON.stringify(checkpoint)) as AgentRunCheckpoint;
	const resumed = await resolveRunConfigSnapshot(
		{ userId: USER_A, sandboxAutoStart: true, restored: restored.configSnapshot },
		{ env: {}, loadConfig: async () => { throw new Error("não deveria reler a conta"); } },
	);
	assert.equal(resumed.reused, true);
	assert.deepEqual(resumed.snapshot, first.snapshot);
	assert.equal(resumed.snapshot.maxOutputTokens, 4096);
	assert.equal(resumed.snapshot.imageModel, undefined);

	// O run seguinte enxerga a mudança.
	const next = await resolveRunConfigSnapshot({ userId: USER_A, sandboxAutoStart: true }, { env: {}, loadConfig: loader });
	assert.equal(next.snapshot.maxOutputTokens, 32768);
	assert.equal(next.snapshot.imageModel, "novo/modelo");
});

test("snapshot corrompido no checkpoint é ignorado e resolvido de novo", async () => {
	const { snapshot, reused } = await resolveRunConfigSnapshot(
		{ userId: USER_A, sandboxAutoStart: true, restored: { v: 1, chatgptEnabled: "sim" } },
		{ env: {}, loadConfig: load },
	);
	assert.equal(reused, false);
	assert.equal(snapshot.maxOutputTokens, 16384);
});

test("withConfigSnapshot não perde o resto do checkpoint nem muta a entrada", async () => {
	const { snapshot } = await resolveRunConfigSnapshot({ userId: USER_A, sandboxAutoStart: true }, { env: {}, loadConfig: load });
	const base = { version: 1, messages: [], nextStepIndex: 3 } as AgentRunCheckpoint;
	const out = withConfigSnapshot(base, snapshot);
	assert.equal(out.nextStepIndex, 3);
	assert.deepEqual(out.configSnapshot, snapshot);
	assert.equal(base.configSnapshot, undefined);
	// Um checkpoint seguinte, sem a chave, volta a levar o mesmo snapshot.
	assert.deepEqual(withConfigSnapshot({ ...out, configSnapshot: undefined }, snapshot).configSnapshot, snapshot);
});

test("falha ao ler a conta cai no env/padrão sem derrubar o run", async () => {
	const original = console.error;
	const logged: unknown[][] = [];
	console.error = (...args: unknown[]) => void logged.push(args);
	try {
		const { snapshot } = await resolveRunConfigSnapshot(
			{ userId: USER_A, sandboxAutoStart: undefined },
			{ env: { JEV_MCP_MODE: "gate" }, loadConfig: async () => { throw new Error("postgres://user:senha@host/db"); } },
		);
		assert.equal(snapshot.jevMcpMode, "gate");
		assert.equal(snapshot.sandboxAutoStart, true);
		assert.ok(!JSON.stringify(logged).includes("senha"), "o erro cru não vai para o log");
	} finally {
		console.error = original;
	}
});

test("orçamento: request > bot > conta > código", async () => {
	const { snapshot } = await resolveRunConfigSnapshot({ userId: USER_A, sandboxAutoStart: true }, { env: {}, loadConfig: load });
	const account = accountBudgetPolicy(snapshot, 100);
	assert.deepEqual(account, { hardMaxSteps: 100, maxWallMs: 300_000 });
	// Request default (100): a conta vale.
	assert.equal(resolveBudget({ maxSteps: 100, policy: { ...account } }).hardMaxSteps, 100);
	assert.equal(resolveBudget({ maxSteps: 100, policy: { ...account } }).maxWallMs, 300_000);
	// Request que pediu menos que o teto vence a conta.
	const small = accountBudgetPolicy(snapshot, 12);
	assert.equal(small.hardMaxSteps, undefined);
	assert.equal(resolveBudget({ maxSteps: 12, policy: { ...small } }).hardMaxSteps, 12);
	// Bot e request vencem a conta.
	assert.equal(resolveBudget({ maxSteps: 100, policy: { ...account, hardMaxSteps: 50, maxWallMs: 60_000 } }).hardMaxSteps, 50);
	assert.equal(resolveBudget({ maxSteps: 100, policy: { ...account, maxWallMs: 60_000 } }).maxWallMs, 60_000);
});

test("teto de custo da conta chega ao runtime: o menor entre pedido/bot (ou o que sobrou da retomada) e a conta", async () => {
	const { snapshot } = await resolveRunConfigSnapshot({ userId: USER_A, sandboxAutoStart: true }, { env: {}, loadConfig: load });
	const withCap = { ...snapshot, maxRunCostUsd: 2 };
	const without = { ...snapshot, maxRunCostUsd: undefined };
	// só a conta: o runtime recebe o teto dela (antes o campo nunca era preenchido)
	assert.equal(effectiveCostCapUsd(undefined, withCap), 2);
	// a conta é teto, não piso: pedido/bot mais baixo vence, mais alto não passa dela
	assert.equal(effectiveCostCapUsd(0.5, withCap), 0.5);
	assert.equal(effectiveCostCapUsd(10, withCap), 2);
	// retomada automática: o que sobrou (0.3) vence a conta
	assert.equal(effectiveCostCapUsd(0.3, withCap), 0.3);
	assert.equal(effectiveCostCapUsd(undefined, without), undefined);
	assert.equal(effectiveCostCapUsd(0, { maxRunCostUsd: 0 }), undefined);
	const budget = resolveBudget({ maxSteps: 100, policy: accountBudgetPolicy(withCap, 100) });
	assert.equal(runtimeBudgetParams(budget, effectiveCostCapUsd(budget.maxCostUsd, withCap)).maxCostUsd, 2);
	assert.equal("maxCostUsd" in runtimeBudgetParams(budget, undefined), false);
	// o runtime recusa o gasto acima do teto com o tipo "cost" (a mesma resolução que ele faz)
	assert.equal(resolveBudget({ maxSteps: 100, policy: runtimeBudgetParams(budget, 2) }).maxCostUsd, 2);
});

test("modelo de visão da conta é só OpenRouter e opcional", async () => {
	const { snapshot } = await resolveRunConfigSnapshot({ userId: USER_A, sandboxAutoStart: true }, { env: {}, loadConfig: load });
	assert.equal(visionFallbackFromSnapshot(snapshot), "a/see");
	const env = await resolveRunConfigSnapshot({ userId: USER_B, sandboxAutoStart: true }, { env: { ATLAS_VISION_FALLBACK_MODEL: "chatgpt/gpt-5" }, loadConfig: load });
	assert.equal(visionFallbackFromSnapshot(env.snapshot), "openai/gpt-4o-mini");
});

test("manutenção: modelo do dono > boot; B não usa o de A; sem dono vale o boot", async () => {
	const boot = { summarizerModel: "boot/sum", maintenanceModel: "boot/maint" };
	assert.equal(await resolveMaintenanceModelForJob({ kind: "memory-review", config: boot, userId: USER_A }, { loadConfig: load }), "a/maint");
	assert.equal(await resolveMaintenanceModelForJob({ kind: "summary", config: boot, userId: USER_A }, { loadConfig: load }), "a/maint");
	assert.equal(await resolveMaintenanceModelForJob({ kind: "memory-review", config: boot, userId: USER_B }, { loadConfig: load }), "boot/maint");
	assert.equal(await resolveMaintenanceModelForJob({ kind: "summary", config: boot, userId: USER_B }, { loadConfig: load }), "boot/sum");
	assert.equal(await resolveMaintenanceModelForJob({ kind: "summary", config: boot }), "boot/sum");
	// Resumo pelo dono da conversa.
	const byConversation = async (id: string) => (id === "conv-a" ? configs[USER_A]! : { v: 1 as const });
	assert.equal(await resolveMaintenanceModelForJob({ kind: "summary", config: boot, conversationId: "conv-a" }, { loadByConversation: byConversation }), "a/maint");
	assert.equal(await resolveMaintenanceModelForJob({ kind: "summary", config: boot, conversationId: "conv-b" }, { loadByConversation: byConversation }), "boot/sum");
});

test("manutenção nunca vira chatgpt/*, mesmo com config antiga corrompida", async () => {
	const boot = { summarizerModel: "chatgpt/gpt-5" };
	assert.equal(await resolveMaintenanceModelForJob({ kind: "summary", config: boot }), "openai/gpt-6-luna");
	const bad = async () => ({ v: 1, models: { maintenance: "chatgpt/x" } }) as AccountConfigV1;
	assert.equal(await resolveMaintenanceModelForJob({ kind: "memory-review", config: { summarizerModel: "boot/sum" }, userId: USER_A }, { loadConfig: bad }), "boot/sum");
});

test("manutenção: falha ao ler a conta usa o modelo do boot", async () => {
	const original = console.error;
	console.error = () => {};
	try {
		const model = await resolveMaintenanceModelForJob(
			{ kind: "summary", config: { summarizerModel: "boot/sum" }, userId: USER_A },
			{ loadConfig: async () => { throw new Error("db fora"); } },
		);
		assert.equal(model, "boot/sum");
	} finally {
		console.error = original;
	}
});

test("modelo padrão de job sem modelo: usuário > servidor", async () => {
	assert.equal(await resolveDefaultModelForJob({ userId: USER_A, serverDefault: "srv/m" }, { loadConfig: load }), "a/default");
	assert.equal(await resolveDefaultModelForJob({ userId: USER_B, serverDefault: "srv/m" }, { loadConfig: load }), "srv/m");
	assert.equal(await resolveDefaultModelForJob({ serverDefault: "srv/m" }), "srv/m");
});

test("modelo para código: bot vence a conta; sem nada, segue o modelo do run", async () => {
	const base = { runModel: "n/m", openRouterKey: true, isKnown: async () => true, log: () => {} };
	assert.equal(await resolveRunCodingModel({ ...base, botPolicy: { codingModel: "bot/m" }, snapshot: { codingModel: "acc/m", chatgptEnabled: false } }), "bot/m");
	assert.equal(await resolveRunCodingModel({ ...base, botPolicy: {}, snapshot: { codingModel: "acc/m", chatgptEnabled: false } }), "acc/m");
	assert.equal(await resolveRunCodingModel({ ...base, botPolicy: null, snapshot: { chatgptEnabled: false } }), null);
	assert.equal(await resolveRunCodingModel({ ...base, botPolicy: { codingModel: "n/m" }, snapshot: { chatgptEnabled: false } }), null);
});

test("modelo para código indisponível cai no modelo normal e registra no log", async () => {
	const logs: string[] = [];
	const base = { runModel: "n/m", botPolicy: null, log: (message: string) => logs.push(message) };
	// ChatGPT desligado na conta.
	assert.equal(await resolveRunCodingModel({ ...base, openRouterKey: true, isKnown: async () => true, snapshot: { codingModel: "chatgpt/luna", chatgptEnabled: false } }), null);
	// Sem chave OpenRouter no worker.
	assert.equal(await resolveRunCodingModel({ ...base, openRouterKey: false, isKnown: async () => true, snapshot: { codingModel: "a/b", chatgptEnabled: true } }), null);
	// Modelo que saiu do catálogo.
	assert.equal(await resolveRunCodingModel({ ...base, openRouterKey: true, isKnown: async () => false, snapshot: { codingModel: "a/gone", chatgptEnabled: true } }), null);
	assert.equal(logs.length, 3);
	// Catálogo fora do ar não bloqueia.
	assert.equal(await resolveRunCodingModel({ ...base, openRouterKey: true, isKnown: async () => null, snapshot: { codingModel: "a/b", chatgptEnabled: true } }), "a/b");
	// ChatGPT ligado e conhecido.
	assert.equal(await resolveRunCodingModel({ ...base, openRouterKey: false, isKnown: async () => true, snapshot: { codingModel: "chatgpt/luna", chatgptEnabled: true } }), "chatgpt/luna");
});

test("tamanho máximo do resultado de ferramentas: sem escolha fica indefinido, a escolha da conta chega à lib", async () => {
	const none = await resolveRunConfigSnapshot({ userId: USER_B, sandboxAutoStart: true }, { env: {}, loadConfig: load });
	assert.equal(runtimeParamsFromSnapshot(none.snapshot).toolResultMaxChars, undefined);
	const big = await resolveRunConfigSnapshot(
		{ userId: USER_B, sandboxAutoStart: true },
		{ env: {}, loadConfig: async () => ({ v: 1, execution: { toolResultMaxChars: 100_000 } }) },
	);
	assert.equal(runtimeParamsFromSnapshot(big.snapshot).toolResultMaxChars, 100_000);
});

test("níveis por dificuldade: sem modo Automático ou sem nível configurado = nada (o run segue o modelo dele)", async () => {
	const base = { botPolicy: null, openRouterKey: true, isKnown: async () => true };
	assert.equal(await resolveRunModelTiers({ ...base, auto: false, snapshot: { modelTiers: { easy: ["a/x"] }, chatgptEnabled: false } }), undefined);
	assert.equal(await resolveRunModelTiers({ ...base, auto: true, snapshot: { chatgptEnabled: false } }), undefined);
});

test("níveis por dificuldade: conta + bot, o nível do bot vence e o resto herda a conta", async () => {
	const runtime = await resolveRunModelTiers({
		auto: true,
		botPolicy: { modelTiers: { hard: ["bot/hard"] } },
		openRouterKey: true,
		isKnown: async () => true,
		snapshot: { modelTiers: { easy: ["a/easy"], hard: ["a/hard"] }, classifyWithReviewer: true, chatgptEnabled: false },
	});
	assert.deepEqual(runtime, { tiers: { easy: ["a/easy"], hard: ["bot/hard"] }, classifyWithReviewer: true });
});

test("níveis por dificuldade: tira modelo de provedor indisponível ou fora do catálogo; nível que esvazia herda", async () => {
	const runtime = await resolveRunModelTiers({
		auto: true,
		botPolicy: null,
		openRouterKey: true,
		isKnown: async (id) => (id === "a/gone" ? false : id === "a/offline" ? null : true),
		snapshot: { modelTiers: { easy: ["chatgpt/luna", "a/gone", "a/ok"], medium: ["chatgpt/luna"], hard: ["a/offline"] }, chatgptEnabled: false },
	});
	assert.deepEqual(runtime, { tiers: { easy: ["a/ok"], hard: ["a/offline"] } });
	const noKey = await resolveRunModelTiers({
		auto: true,
		botPolicy: null,
		openRouterKey: false,
		isKnown: async () => true,
		snapshot: { modelTiers: { easy: ["a/x"] }, chatgptEnabled: false },
	});
	assert.equal(noKey, undefined);
});
