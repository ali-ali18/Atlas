import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import { capabilityOf, summarizeMatrix, type MatrixRun } from "./aggregate.js";
import { BudgetGuard, countThatFit } from "./budget.js";
import { resolveEngines } from "./engines.js";
import { buildEstimate, estimateExecutionUsd, formatEstimate, estimatesInOrder, type ExecutionProfile } from "./estimate.js";
import { assertProviderKeys, providerSecrets, resolveModelSpec } from "./models.js";
import { PRICE_TABLE, UNKNOWN_PRICE, costFromTokens, priceFor, type PriceEntry } from "./pricing.js";
import { createMatrixRouter, createRealProviders, withCostAccounting, withSessionId, type MatrixProviders } from "./providers.js";
import type { Scenario } from "../scenario.js";
import { strongMatcher } from "../verdict.js";

const params = (model: string): CompleteChatWithToolsParams => ({ model, apiKey: "x", messages: [{ role: "user", content: "oi" }], tools: [] });
const result = (usage: CompleteChatWithToolsResult["usage"]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: "ok" }, ...(usage ? { usage } : {}) });

describe("modelos por prefixo", () => {
	it("anthropic/ vai para o Anthropic direto, opencode-go/ para o Go, o resto para o OpenRouter", () => {
		expect(resolveModelSpec("anthropic/claude-haiku-5-5")).toMatchObject({ provider: "anthropic", internalId: "anthropic-direct/claude-haiku-5-5", priceKey: "anthropic/claude-haiku-5-5" });
		expect(resolveModelSpec("opencode-go/qwen3.8-flash")).toMatchObject({ provider: "opencode-go", internalId: "opencode-go/qwen3.8-flash" });
		expect(resolveModelSpec("openrouter/anthropic/claude-sonnet-5-5")).toMatchObject({ provider: "openrouter", internalId: "anthropic/claude-sonnet-5-5" });
		expect(resolveModelSpec("deepseek/deepseek-chat-v3.1")).toMatchObject({ provider: "openrouter", internalId: "deepseek/deepseek-chat-v3.1" });
	});

	it("recusa ids internos de outros provedores e slug inválido", () => {
		expect(() => resolveModelSpec("chatgpt/gpt-5")).toThrow(/prefixo/);
		expect(() => resolveModelSpec("anthropic-direct/x")).toThrow(/prefixo/);
		expect(() => resolveModelSpec("anthropic/bad slug")).toThrow(/inválido/);
		expect(() => resolveModelSpec("")).toThrow();
	});

	it("o roteador do packages/llm entrega cada id interno ao provedor certo", async () => {
		const calls: string[] = [];
		const spy = (name: string) => vi.fn(async (p: CompleteChatWithToolsParams) => (calls.push(`${name}:${p.model}`), result({ promptTokens: 1 })));
		const providers: MatrixProviders = { anthropic: spy("anthropic"), opencodeGo: spy("go"), openrouter: spy("or") };
		const router = createMatrixRouter(providers);
		for (const spec of ["anthropic/claude-haiku-5-5", "opencode-go/deepseek-v4.1-flash", "openrouter/vendor/model", "vendor/other"]) await router(params(resolveModelSpec(spec).internalId));
		expect(calls).toEqual(["anthropic:anthropic-direct/claude-haiku-5-5", "go:opencode-go/deepseek-v4.1-flash", "or:vendor/model", "or:vendor/other"]);
	});

	it("provedores reais batem na URL e no cabeçalho certos (fetch falso, sem rede; o protocolo chat do Go usa o fetch global e fica fora)", async () => {
		const seen: Array<{ url: string; headers: Record<string, string> }> = [];
		const fakeFetch = (async (url: string, init?: RequestInit) => {
			seen.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
			return new Response("{}", { status: 401 });
		}) as unknown as typeof fetch;
		const providers = createRealProviders({ CLAUDE_KEY: "k-anthropic", OPENCODE_GO_API_KEY: "k-go" }, { fetch: fakeFetch });
		const router = createMatrixRouter(withSessionId(providers, "sess-1"));
		for (const spec of ["anthropic/claude-haiku-5-5", "opencode-go/qwen3.8-flash"]) await router(params(resolveModelSpec(spec).internalId)).catch(() => undefined);
		expect(seen.map((item) => item.url)).toEqual(["https://api.anthropic.com/v1/messages", "https://opencode.ai/inference/go/v1/messages"]);
		expect(seen[0]!.headers["x-api-key"]).toBe("k-anthropic");
		// O Go exige a sessão estável (sem ela responde 400 MissingSessionID).
		expect(seen[1]!.headers["x-opencode-session"]).toBe("sess-1");
	});
});

describe("chaves", () => {
	it("falta de chave nomeia a variável e nunca mostra valor", () => {
		const models = ["anthropic/claude-haiku-5-5", "opencode-go/qwen3.8-flash"].map(resolveModelSpec);
		const env = { OPENCODE_GO_API_KEY: "go-secret-value" };
		let message = "";
		try {
			assertProviderKeys(models, env);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("CLAUDE_KEY");
		expect(message).toContain("ANTHROPIC_API_KEY");
		expect(message).not.toContain("go-secret-value");
		expect(message).not.toContain("OPENCODE_GO_API_KEY");
	});

	it("CLAUDE_KEY tem prioridade e ANTHROPIC_API_KEY serve de reserva", () => {
		const models = [resolveModelSpec("anthropic/claude-haiku-5-5")];
		expect(() => assertProviderKeys(models, { ANTHROPIC_API_KEY: "a" })).not.toThrow();
		expect(providerSecrets(models, { CLAUDE_KEY: "c", ANTHROPIC_API_KEY: "a" }).sort()).toEqual(["a", "c"]);
	});

	it("motor desconhecido falha com a lista dos disponíveis", () => {
		expect(() => resolveEngines(["v9"])).toThrow(/v1, v2/);
		expect(resolveEngines(["v2", "v1", "v2"]).map((engine) => engine.id)).toEqual(["v2", "v1"]);
	});
});

describe("preço e custo", () => {
	it("tabela traz os valores do plano e preço desconhecido cai no conservador, sinalizado", () => {
		expect(PRICE_TABLE["opencode-go/deepseek-v4.1-flash"]).toMatchObject({ promptUsdPerMTok: 0.3, completionUsdPerMTok: 1.2 });
		expect(PRICE_TABLE["opencode-go/qwen3.8-flash"]).toMatchObject({ promptUsdPerMTok: 0.15, completionUsdPerMTok: 0.47 });
		expect(PRICE_TABLE["opencode-go/claude-haiku-5-5"]).toMatchObject({ promptUsdPerMTok: 0.1, completionUsdPerMTok: 0.5 });
		expect(priceFor("anthropic/claude-opus-5-5").price).toMatchObject({ promptUsdPerMTok: 4, completionUsdPerMTok: 20, cachedRatio: 0.05, confirmed: true });
		expect(priceFor("anthropic/claude-sonnet-5-5").price).toMatchObject({ promptUsdPerMTok: 2, completionUsdPerMTok: 10, confirmed: true });
		expect(priceFor("opencode-go/nada")).toEqual({ price: UNKNOWN_PRICE, known: false });
	});

	it("cache lido e gravado entram com seus múltiplos", () => {
		const price: PriceEntry = { promptUsdPerMTok: 1, completionUsdPerMTok: 5, cachedRatio: 0.1, writeRatio: 1.25, source: "t", confirmed: true };
		// 100 novos + 800 lidos (0,1x) + 100 gravados (1,25x) = 100 + 80 + 125 = 305 tokens-equivalentes; + 200 de saída.
		expect(costFromTokens({ promptTokens: 1000, cachedTokens: 800, cacheWriteTokens: 100, completionTokens: 200 }, price)).toBeCloseTo((305 * 1 + 200 * 5) / 1e6, 10);
	});

	it("Anthropic/Go: custo vem da tabela; modelo fora dela fica costUnknown; OpenRouter mantém o custo real", async () => {
		const stream = (usage: CompleteChatWithToolsResult["usage"]) => withCostAccounting(async () => result(usage));
		const known = await stream({ promptTokens: 1_000_000, completionTokens: 1_000_000, costUnknown: true })(params("anthropic-direct/claude-haiku-5-5"));
		expect(known.usage?.costUsd).toBeCloseTo(0.6, 6);
		expect(known.usage?.costUnknown).toBeUndefined();
		const go = await stream({ promptTokens: 1_000_000, completionTokens: 0, costKind: "plan" })(params("opencode-go/qwen3.8-flash"));
		expect(go.usage?.costUsd).toBeCloseTo(0.15, 6);
		expect(go.usage?.costKind).toBeUndefined();
		const unknown = await stream({ promptTokens: 1_000_000, completionTokens: 0, costUnknown: true })(params("opencode-go/modelo-novo"));
		expect(unknown.usage?.costUsd).toBeCloseTo(3, 6);
		expect(unknown.usage?.costUnknown).toBe(true);
		const router = await stream({ promptTokens: 10, costUsd: 0.42 })(params("vendor/model"));
		expect(router.usage?.costUsd).toBe(0.42);
		expect(router.usage?.costUnknown).toBeUndefined();
		const withoutUsage = await stream(undefined)(params("anthropic-direct/claude-haiku-5-5"));
		expect(withoutUsage.usage?.costUnknown).toBe(true);
	});
});

describe("teto de gasto", () => {
	it("reserva estimativas em andamento e trava no primeiro estouro", () => {
		const guard = new BudgetGuard(1);
		expect(guard.tryReserve(0.4)).toBe(true);
		expect(guard.tryReserve(0.4)).toBe(true);
		expect(guard.tryReserve(0.3)).toBe(false); // 0.8 reservado + 0.3 > 1
		guard.settle(0.4, 0.1);
		guard.settle(0.4, 0.1);
		// Travou: mesmo cabendo agora, nada mais é agendado.
		expect(guard.tryReserve(0.01)).toBe(false);
		expect(guard.stopped).toBe(true);
		expect(guard.spentUsd).toBeCloseTo(0.2, 10);
	});

	it("exatamente no teto passa; o juiz gasta do mesmo teto; teto inválido falha", () => {
		const guard = new BudgetGuard(1);
		guard.charge(0.5);
		expect(guard.tryReserve(0.5)).toBe(true);
		expect(guard.tryReserve(0.0001)).toBe(false);
		expect(() => new BudgetGuard(0)).toThrow();
		expect(() => new BudgetGuard(Number.NaN)).toThrow();
		expect(new BudgetGuard(undefined).tryReserve(1e9)).toBe(true);
	});

	it("countThatFit conta as execuções que cabem em ordem", () => {
		expect(countThatFit([0.3, 0.3, 0.3, 0.3], 1)).toBe(3);
		expect(countThatFit([2], 1)).toBe(0);
		expect(countThatFit([0.5, 0.5], 1)).toBe(2);
	});
});

describe("estimativa", () => {
	const scenarios = [{ id: "a" }, { id: "b" }] as Scenario[];
	const engines = resolveEngines(["v2", "v1"]);
	const models = ["anthropic/claude-haiku-5-5", "opencode-go/qwen3.8-flash", "opencode-go/modelo-novo"].map(resolveModelSpec);
	const profiles = new Map<string, ExecutionProfile>([
		["a|v2", { modelCalls: 2, promptTokens: 1_000_000, completionTokens: 100_000, fromMock: true }],
		["b|v2", { modelCalls: 2, promptTokens: 500_000, completionTokens: 0, fromMock: true }],
		["a|v1", { modelCalls: 2, promptTokens: 2_000_000, completionTokens: 0, fromMock: true }],
		["b|v1", { modelCalls: 2, promptTokens: 0, completionTokens: 100_000, fromMock: true }],
	]);

	it("custo de uma execução = tokens × fator × preço, sem desconto de cache", () => {
		const price: PriceEntry = { promptUsdPerMTok: 1, completionUsdPerMTok: 5, cachedRatio: 0.1, writeRatio: 1.25, source: "t", confirmed: true };
		expect(estimateExecutionUsd(profiles.get("a|v2")!, price, 2)).toBeCloseTo((2_000_000 * 1 + 200_000 * 5) / 1e6, 10);
	});

	it("soma por motor × modelo, repetições e preço desconhecido sinalizado", () => {
		const estimate = buildEstimate({ scenarios, engines, models, repeat: 3, profiles, factor: 2 });
		expect(estimate.executions).toBe(2 * 2 * 3 * 3);
		const row = estimate.rows.find((item) => item.engine === "v2" && item.model === "opencode-go/qwen3.8-flash")!;
		// v2: a = (2M*0.15 + 200k*0.47)/1e6 = 0.394 ; b = (1M*0.15)/1e6 = 0.15 ; × 3 repetições.
		expect(row.usd).toBeCloseTo((0.394 + 0.15) * 3, 6);
		expect(row.promptTokens).toBe(1_500_000 * 2 * 3);
		expect(estimate.rows.find((item) => item.model === "opencode-go/modelo-novo")!.priceKnown).toBe(false);
		expect(estimate.anyUnknown).toBe(true);
		expect(estimate.anyUnconfirmed).toBe(true);
		expect(estimate.totalUsd).toBeCloseTo(estimate.rows.reduce((sum, item) => sum + item.usd, 0), 10);
	});

	it("com teto, diz quantas execuções cabem e a soma das estimativas em ordem fecha com o total", () => {
		const input = { scenarios, engines, models, repeat: 2, profiles, factor: 2 };
		const ordered = estimatesInOrder(input);
		expect(ordered).toHaveLength(2 * 2 * 3 * 2);
		const estimate = buildEstimate({ ...input, capUsd: 1 });
		expect(estimate.fitsInCap?.executions).toBe(countThatFit(ordered, 1));
		expect(ordered.reduce((sum, item) => sum + item, 0)).toBeCloseTo(estimate.totalUsd, 8);
		const text = formatEstimate(estimate);
		expect(text).toContain("TOTAL");
		expect(text).toContain("a confirmar");
		expect(text).toContain("cabem");
	});
});

const run = (over: Partial<MatrixRun>): MatrixRun => ({ scenarioId: "s1", capability: "email", engine: "v2", model: "anthropic/claude-sonnet-5-5", provider: "anthropic", repeat: 0, status: "done", pass: true, failedChecks: [], steps: 3, promptTokens: 1000, completionTokens: 100, costUsd: 0.01, costUnknown: false, durationMs: 1000, estimatedUsd: 0.02, ...over });
const cellRuns = (scenarioId: string, capability: string, model: string, engine: string, passes: boolean[], failed: string[] = ["tool_called"]): MatrixRun[] =>
	passes.map((pass, repeat) => run({ scenarioId, capability, model, engine, repeat, pass, failedChecks: pass ? [] : failed, provider: model.split("/")[0]! }));

describe("agregação do relatório", () => {
	const strong = "anthropic/claude-sonnet-5-5";
	const cheap = "opencode-go/qwen3.8-flash";
	const runs: MatrixRun[] = [
		// s1 (email): o forte passa e o barato falha → modelo
		...cellRuns("s1", "email", strong, "v2", [true, true, true]),
		...cellRuns("s1", "email", cheap, "v2", [false, false, false]),
		// s2 (email): falha em todos → harness
		...cellRuns("s2", "email", strong, "v2", [false, false, false], ["no_question"]),
		...cellRuns("s2", "email", cheap, "v2", [false, false, false], ["no_question"]),
		// s3 (compras): repetições divergem → instável
		...cellRuns("s3", "compras", strong, "v2", [true, false, true]),
		...cellRuns("s3", "compras", cheap, "v2", [true, true, true]),
		// s1 no motor v1, mais um pulado pelo teto
		...cellRuns("s1", "email", strong, "v1", [true, false, true]),
		run({ scenarioId: "s1", engine: "v1", model: cheap, provider: "opencode-go", repeat: 0, status: "skipped_budget", pass: false, costUsd: 0 }),
	];
	const summary = summarizeMatrix(runs, {
		engines: ["v2", "v1"],
		models: [strong, cheap],
		scenarios: [{ id: "s1", capability: "email" }, { id: "s2", capability: "email" }, { id: "s3", capability: "compras" }],
		repeat: 3,
		mode: "simulate",
		capUsd: 1,
		isStrong: strongMatcher(),
		createdAt: "2026-11-05T00:00:00.000Z",
	});

	it("leitura harness × modelo por cenário e motor", () => {
		expect(summary.readings.s1!.v2).toMatchObject({ verdict: "modelo" });
		expect(summary.readings.s2!.v2).toMatchObject({ verdict: "harness/instruções" });
		expect(summary.readings.s3!.v2).toMatchObject({ verdict: "instável" });
	});

	it("lacuna conhecida do motor (tag lacuna-v2) continua harness, mas o motivo diz que já se sabia", () => {
		const tagged = summarizeMatrix(runs, {
			engines: ["v2"],
			models: [strong, cheap],
			scenarios: [{ id: "s2", capability: "email", tags: ["gold", "email", "lacuna-v2"] }],
			repeat: 3,
			mode: "simulate",
			isStrong: strongMatcher(),
			createdAt: "2026-11-05T00:00:00.000Z",
		});
		expect(tagged.readings.s2!.v2).toMatchObject({ verdict: "harness/instruções", reason: expect.stringContaining("lacuna conhecida do motor v2") });
	});

	it("agrega por capacidade e por modelo, sem contar pulados como execução", () => {
		expect(summary.byCapability.email!.v2![strong]).toMatchObject({ runs: 6, passes: 3 });
		expect(summary.byCapability.email!.v2![cheap]).toMatchObject({ runs: 6, passes: 0 });
		expect(summary.byCapability.email!.v2![cheap]!.failing).toEqual({ tool_called: 3, no_question: 3 });
		expect(summary.byCapability.compras!.v2![strong]).toMatchObject({ runs: 3, passes: 2 });
		expect(summary.byModel.v2![strong]).toMatchObject({ runs: 9, passes: 5, steps: 27 });
		expect(summary.cells.s1!.v1![cheap]).toMatchObject({ runs: 0, skipped: 1 });
		expect(summary.skippedBudget).toBe(1);
		expect(summary.budgetStopped).toBe(true);
	});

	it("diferença de motor em pontos percentuais e quebra por provedor", () => {
		const delta = summary.engineDeltas.find((item) => item.model === strong)!;
		// v2 do forte: 5/9 = 56%; v1: 2/3 = 67% → +11 pp (arredondado).
		expect(delta).toMatchObject({ engine: "v1", base: "v2", deltaPp: 11 });
		expect(summary.engineDeltas.find((item) => item.model === cheap)!.passRate).toBeNull();
		expect(Object.keys(summary.byProvider).sort()).toEqual(["anthropic", "opencode-go"]);
		expect(summary.byProvider.anthropic!.runs).toBe(12);
	});

	it("capacidade vem da pasta do ouro (2ª tag)", () => {
		expect(capabilityOf(["gold", "email", "x"])).toBe("email");
		expect(capabilityOf(["rotinas"])).toBe("rotinas");
		expect(capabilityOf([])).toBe("geral");
	});
});
