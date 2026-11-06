import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import { capabilityOf, cleanPassRateOf, cleanRunsOf, passRateOf, setOf, summarizeMatrix, type MatrixRun } from "./aggregate.js";
import { formatMatrixReport } from "./format.js";
import { BudgetExhaustedError, BudgetGuard, countThatFit, withBudgetGate } from "./budget.js";
import { resolveEngines } from "./engines.js";
import { buildEstimate, CACHE_READ_SHARE, COMPLETION_FACTOR, DEFAULT_ESTIMATE_FACTOR, ESTIMATE_MARGIN, estimateExecutionUsd, estimateJudgeUsd, FALLBACK_PROFILE, formatEstimate, estimatesInOrder, judgeProfileOf, JUDGE_COMPLETION_TOKENS, profileFromMock, profileKey, profileScenarios, type ExecutionProfile } from "./estimate.js";
import { assertProviderKeys, providerSecrets, resolveModelSpec } from "./models.js";
import { PRICE_TABLE, UNKNOWN_PRICE, costFromTokens, priceFor, type PriceEntry } from "./pricing.js";
import { createMatrixRouter, createRealProviders, withCostAccounting, withSessionId, type MatrixProviders } from "./providers.js";
import { buildJudgePrompt, buildJudgeSystem } from "../quality.js";
import { parseScenario, type Scenario } from "../scenario.js";
import type { Trajectory } from "../trajectory.js";
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

	it("Haiku 5.5 acima de 100K tokens de entrada na chamada custa 0,50/2,50 (auditoria F0, M4)", () => {
		const haiku = priceFor("anthropic/claude-haiku-5-5").price;
		expect(haiku.longContext).toEqual({ abovePromptTokens: 100_000, promptUsdPerMTok: 0.5, completionUsdPerMTok: 2.5 });
		// No corte (100K exatos) ainda vale a tarifa normal; 1 token a mais muda a chamada inteira para a longa.
		expect(costFromTokens({ promptTokens: 100_000, completionTokens: 10_000 }, haiku)).toBeCloseTo((100_000 * 0.1 + 10_000 * 0.5) / 1e6, 10);
		expect(costFromTokens({ promptTokens: 100_001, completionTokens: 10_000 }, haiku)).toBeCloseTo((100_001 * 0.5 + 10_000 * 2.5) / 1e6, 10);
		// Cache lido usa a mesma tarifa longa (0,1x de 0,50).
		expect(costFromTokens({ promptTokens: 200_000, cachedTokens: 150_000, completionTokens: 0 }, haiku)).toBeCloseTo((50_000 * 0.5 + 150_000 * 0.1 * 0.5) / 1e6, 10);
		// Outros modelos não têm tarifa longa.
		expect(priceFor("anthropic/claude-sonnet-5-5").price.longContext).toBeUndefined();
	});

	it("o corte é por chamada: duas chamadas de 60K não pagam a tarifa longa, uma de 120K paga (via withCostAccounting)", async () => {
		const stream = (prompt: number) => withCostAccounting(async () => result({ promptTokens: prompt, completionTokens: 0, costUnknown: true }))(params("anthropic-direct/claude-haiku-5-5"));
		const two = (await stream(60_000)).usage!.costUsd! * 2;
		const one = (await stream(120_000)).usage!.costUsd!;
		expect(two).toBeCloseTo((120_000 * 0.1) / 1e6, 10);
		expect(one).toBeCloseTo((120_000 * 0.5) / 1e6, 10);
	});

	it("Anthropic/Go: custo vem da tabela; modelo fora dela fica costUnknown; OpenRouter mantém o custo real", async () => {
		const stream = (usage: CompleteChatWithToolsResult["usage"]) => withCostAccounting(async () => result(usage));
		const known = await stream({ promptTokens: 50_000, completionTokens: 50_000, costUnknown: true })(params("anthropic-direct/claude-haiku-5-5"));
		expect(known.usage?.costUsd).toBeCloseTo(0.03, 8);
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
	it("reserva estimativas em andamento; o que não cabe é recusado, mas não trava as execuções mais baratas (auditoria F0, M1)", () => {
		const guard = new BudgetGuard(1);
		const a = guard.reserve(0.4)!;
		const b = guard.reserve(0.4)!;
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(guard.reserve(0.3)).toBeNull(); // 0.8 reservado + 0.3 > 1
		expect(guard.stopped).toBe(true);
		// Uma execução mais barata que o que sobra (0.2) ainda passa.
		const c = guard.reserve(0.15)!;
		expect(c).not.toBeNull();
		expect(guard.remainingUsd).toBeCloseTo(0.05, 10);
		a.charge(0.1);
		b.charge(0.1);
		c.charge(0.05);
		a.release();
		b.release();
		c.release();
		// Terminadas, o que sobra é o teto menos o gasto real: cabe o que antes era recusado.
		expect(guard.reserve(0.3)).not.toBeNull();
		expect(guard.spentUsd).toBeCloseTo(0.25, 10);
	});

	it("o custo real é cobrado na hora e sai da reserva da execução (não conta duas vezes)", () => {
		const guard = new BudgetGuard(1);
		const lease = guard.reserve(0.5)!;
		expect(guard.remainingUsd).toBeCloseTo(0.5, 10);
		lease.charge(0.2);
		// gasto 0.2 + falta reservar 0.3 = 0.5 comprometido
		expect(guard.spentUsd).toBeCloseTo(0.2, 10);
		expect(guard.remainingUsd).toBeCloseTo(0.5, 10);
		// passou da estimativa: a reserva zera e o excesso já pesa no teto
		lease.charge(0.6);
		expect(lease.reservedUsd).toBe(0);
		expect(guard.remainingUsd).toBeCloseTo(0.2, 10);
	});

	it("ao atingir o teto: aborta as execuções em andamento, barra chamadas novas e recusa o que falta", () => {
		const guard = new BudgetGuard(1);
		const a = guard.reserve(0.3)!;
		const b = guard.reserve(0.3)!;
		a.charge(0.6);
		expect(guard.exhausted).toBe(false);
		expect(a.aborted).toBe(false);
		b.charge(0.4); // gasto = 1.0 = teto
		expect(guard.exhausted).toBe(true);
		// a que cruzou o teto (b) não é abortada, mas também não começa chamada nova; a outra, em voo, é abortada
		expect(a.aborted).toBe(true);
		expect(a.signal.aborted).toBe(true);
		expect(b.aborted).toBe(false);
		expect(() => a.assertCanStart()).toThrow(BudgetExhaustedError);
		expect(() => b.assertCanStart()).toThrow(/teto de gasto atingido/);
		expect(guard.reserve(0.0001)).toBeNull();
	});

	it("withBudgetGate barra a chamada sem tocar o provedor depois do estouro e deixa passar antes", async () => {
		const guard = new BudgetGuard(1);
		const lease = guard.reserve(0.1)!;
		const inner = vi.fn(async () => result({ promptTokens: 1 }));
		const gated = withBudgetGate(inner, lease);
		await gated(params("m"), {});
		expect(inner).toHaveBeenCalledTimes(1);
		lease.charge(2);
		await expect(gated(params("m"), {})).rejects.toBeInstanceOf(BudgetExhaustedError);
		expect(inner).toHaveBeenCalledTimes(1);
	});

	it("drain espera as chamadas em voo, com limite de tempo", async () => {
		const guard = new BudgetGuard(1);
		const lease = guard.reserve(0.1)!;
		let finished = false;
		lease.track(new Promise<void>((resolve) => setTimeout(() => { finished = true; resolve(); }, 20)));
		await lease.drain(1000);
		expect(finished).toBe(true);
		lease.track(new Promise<void>(() => undefined));
		const started = Date.now();
		await lease.drain(30);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it("exatamente no teto passa; o juiz gasta do mesmo teto; teto inválido falha", () => {
		const guard = new BudgetGuard(1);
		guard.charge(0.5);
		expect(guard.reserve(0.5)).not.toBeNull();
		expect(guard.reserve(0.0001)).toBeNull();
		expect(() => new BudgetGuard(0)).toThrow();
		expect(() => new BudgetGuard(Number.NaN)).toThrow();
		expect(new BudgetGuard(undefined).reserve(1e9)).not.toBeNull();
		expect(new BudgetGuard(undefined).exhausted).toBe(false);
	});

	it("countThatFit conta as execuções que cabem em ordem", () => {
		expect(countThatFit([0.3, 0.3, 0.3, 0.3], 1)).toBe(3);
		expect(countThatFit([2], 1)).toBe(0);
		expect(countThatFit([0.5, 0.5], 1)).toBe(2);
		// a que não cabe é pulada e as seguintes, mais baratas, ainda entram
		expect(countThatFit([0.6, 0.6, 0.3], 1)).toBe(2);
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

	it("custo de uma execução: 1ª chamada grava o cache, as seguintes leem 70%; saída total 3x o mock (auditoria F0, M1)", () => {
		const price: PriceEntry = { promptUsdPerMTok: 1, completionUsdPerMTok: 5, cachedRatio: 0.1, writeRatio: 1.25, source: "t", confirmed: true };
		const profile = profiles.get("a|v2")!; // 2 chamadas, 1M de entrada e 100k de saída no total
		expect(CACHE_READ_SHARE).toBe(0.7);
		expect(COMPLETION_FACTOR).toBe(3);
		// factor 1 = as 2 chamadas do mock: 500k de entrada cada (350k de cache) e 300k de saída no total = 150k por chamada
		const first = (150_000 * 1 + 350_000 * 1.25 + 150_000 * 5) / 1e6;
		const later = (150_000 * 1 + 350_000 * 0.1 + 150_000 * 5) / 1e6;
		expect(estimateExecutionUsd(profile, price, 1)).toBeCloseTo((first + later) * ESTIMATE_MARGIN, 10);
		// factor 2 = 4 chamadas: a 1ª grava, as outras 3 leem; a saída total continua 300k (75k por chamada)
		const first2 = (150_000 * 1 + 350_000 * 1.25 + 75_000 * 5) / 1e6;
		const later2 = (150_000 * 1 + 350_000 * 0.1 + 75_000 * 5) / 1e6;
		expect(estimateExecutionUsd(profile, price, 2)).toBeCloseTo((first2 + 3 * later2) * ESTIMATE_MARGIN, 10);
	});

	it("preço sem desconto de cache (modelo desconhecido) não ganha desconto; saída 3x o mock", () => {
		const unknown = priceFor("opencode-go/nada").price;
		const single: ExecutionProfile = { modelCalls: 1, promptTokens: 10_000, completionTokens: 1_000, fromMock: true };
		expect(estimateExecutionUsd(single, unknown, 1)).toBeCloseTo(((10_000 * 3 + 3_000 * 15) / 1e6) * ESTIMATE_MARGIN, 10);
	});

	it("calibrada com as execuções reais de 05/11: antes passava de 1,4x a 2,6x o custo real; agora fica perto dele", () => {
		// haiku: média real de ~51k de entrada e ~1,5k de saída por execução, a US$ 0,0030; o mock desse cenário mede ~22k de entrada e ~0,7k de saída em ~4 chamadas.
		const haiku = priceFor("anthropic/claude-haiku-5-5").price;
		const mock: ExecutionProfile = { modelCalls: 4, promptTokens: 22_000, completionTokens: 700, fromMock: true };
		expect(DEFAULT_ESTIMATE_FACTOR).toBe(2);
		const estimate = estimateExecutionUsd(mock, haiku, DEFAULT_ESTIMATE_FACTOR);
		expect(estimate).toBeGreaterThan(0.003 * 0.9);
		expect(estimate).toBeLessThan(0.003 * 1.4);
		// o cálculo antigo (sem cache, saída x2) dava US$ 0,0047
		const old = costFromTokens({ promptTokens: 44_000, completionTokens: 1_400 }, { ...haiku, cachedRatio: 1, writeRatio: 1 });
		expect(old).toBeGreaterThan(estimate);
	});

	it("a estimativa aplica a tarifa de contexto longo pela chamada média, não pelo total da execução", () => {
		const haiku = priceFor("anthropic/claude-haiku-5-5").price;
		// 10 chamadas de 20K = 200K no total: nenhuma chamada passa de 100K, então é a tarifa normal.
		const short: ExecutionProfile = { modelCalls: 10, promptTokens: 200_000, completionTokens: 0, fromMock: true };
		const perCall = (cachedTokens: number, cacheWriteTokens: number) => costFromTokens({ promptTokens: 20_000, cachedTokens, cacheWriteTokens }, haiku);
		expect(estimateExecutionUsd(short, haiku, 1)).toBeCloseTo((perCall(0, 14_000) + 9 * perCall(14_000, 0)) * ESTIMATE_MARGIN, 10);
		expect(perCall(0, 14_000)).toBeLessThan((20_000 * 0.5 * 1.25) / 1e6);
		// 1 chamada de 200K passa do corte: tarifa longa (0,50), com 70% gravados no cache a 1,25x.
		const long: ExecutionProfile = { modelCalls: 1, promptTokens: 200_000, completionTokens: 0, fromMock: true };
		expect(estimateExecutionUsd(long, haiku, 1)).toBeCloseTo(((60_000 * 0.5 + 140_000 * 0.5 * 1.25) / 1e6) * ESTIMATE_MARGIN, 10);
	});

	it("soma por motor × modelo, repetições e preço desconhecido sinalizado", () => {
		const estimate = buildEstimate({ scenarios, engines, models, repeat: 3, profiles, factor: 2 });
		expect(estimate.executions).toBe(2 * 2 * 3 * 3);
		const row = estimate.rows.find((item) => item.engine === "v2" && item.model === "opencode-go/qwen3.8-flash")!;
		// qwen (cache 0,1x): cada cenário = estimateExecutionUsd com factor 2, × 3 repetições.
		const qwen = priceFor("opencode-go/qwen3.8-flash").price;
		const expected = (estimateExecutionUsd(profiles.get("a|v2")!, qwen, 2) + estimateExecutionUsd(profiles.get("b|v2")!, qwen, 2)) * 3;
		expect(row.usd).toBeCloseTo(expected, 10);
		expect(row.promptTokens).toBe(1_500_000 * 2 * 3);
		expect(row.completionTokens).toBe(100_000 * COMPLETION_FACTOR * 3);
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

	it("capacidade e conjunto também valem para o conjunto genérico (1ª tag `generic`)", () => {
		expect(capabilityOf(["generic", "compras", "x"])).toBe("compras");
		expect(setOf(["gold", "email"])).toBe("gold");
		expect(setOf(["generic", "email"])).toBe("generic");
		expect(setOf(["rotinas"])).toBeNull();
		expect(setOf(undefined)).toBeNull();
	});
});

describe("relatório Markdown (auditoria F0, B1)", () => {
	it("nome de verificação com `|` (any_of:a|b) não quebra a tabela de detalhe", () => {
		const model = "anthropic/claude-sonnet-5-5";
		const name = "any_of:text_contains|tool_called";
		const summary = summarizeMatrix(cellRuns("s1", "email", model, "v2", [false], [name]), { engines: ["v2"], models: [model], scenarios: [{ id: "s1", capability: "email" }], repeat: 1, mode: "simulate", isStrong: strongMatcher(), createdAt: "2026-11-05T00:00:00.000Z" });
		const lines = formatMatrixReport(summary).split("\n");
		const row = lines.find((line) => line.startsWith("| s1 | v2 |"))!;
		expect(row).toContain("any_of:text_contains\\|tool_called (1)");
		// Mesma quantidade de colunas (| sem escape) que o cabeçalho da tabela.
		const columns = (line: string) => line.replace(/\\\|/g, "").split("|").length;
		const header = lines.find((line) => line.startsWith("| cenário | motor | modelo |"))!;
		expect(columns(row)).toBe(columns(header));
	});
});

describe("estimativa do juiz e do perfil (auditoria F0, M2 e B3)", () => {
	const make = (extra: Record<string, unknown> = {}): Scenario => {
		const parsed = parseScenario({ version: 1, id: "j", title: "t", bot: { name: "Ada" }, user: "resuma meus e-mails", expect: [{ type: "judge", rubric: "Traz o conteúdo e a ação de cada e-mail relevante." }], mock: { turns: [{ say: "Resumo curto." }] }, ...extra });
		if (!parsed.ok) throw new Error(parsed.error);
		return parsed.scenario;
	};
	const trajectoryOf = (text: string, over: Partial<Trajectory> = {}): Trajectory => ({
		scenarioId: "j", model: "m", variant: "v2", repeat: 0, startedAt: "", durationMs: 1, text, modelCalls: [{ index: 0, kind: "main", model: "m", messages: [], tools: [], durationMs: 1 }], toolCalls: [], toolResults: [], events: [], visible: [], revised: [], discards: [], steerDelivered: [], unmocked: [],
		costUsd: 0, costUnknown: false, tokens: { prompt: 4000, completion: 200 }, ...over,
	});

	it("o prompt do juiz é medido com a trajetória do mock: resposta maior, prompt maior", () => {
		const scenario = make();
		const small = judgeProfileOf(scenario, trajectoryOf("curta"))!;
		const big = judgeProfileOf(scenario, trajectoryOf("x".repeat(8000)))!;
		const chars = buildJudgeSystem(scenario).length + buildJudgePrompt({ rubric: "Traz o conteúdo e a ação de cada e-mail relevante.", scenario, trajectory: trajectoryOf("curta") }).length;
		expect(small).toEqual({ calls: 1, promptTokens: Math.ceil(chars / 4) });
		expect(big.promptTokens - small.promptTokens).toBe(Math.ceil((chars + 8000 - 5) / 4) - Math.ceil(chars / 4));
		expect(judgeProfileOf(make({ expect: [{ type: "completed" }] }))).toBeUndefined();
	});

	it("duas verificações judge = duas chamadas por juiz", () => {
		const two = make({ expect: [{ type: "judge", id: "a", rubric: "Primeira rubrica longa o bastante." }, { type: "judge", id: "b", rubric: "Segunda rubrica longa o bastante." }] });
		expect(judgeProfileOf(two, trajectoryOf("ok"))!.calls).toBe(2);
	});

	it("custo do juiz = prompt medido + 250 tokens de saída por chamada e por juiz", () => {
		const judges = ["opencode-go/qwen3.8-flash", "anthropic/claude-haiku-5-5"].map(resolveModelSpec);
		const profile: ExecutionProfile = { modelCalls: 1, promptTokens: 1, completionTokens: 1, fromMock: true, judge: { calls: 2, promptTokens: 3000 } };
		const qwen = (1500 * 0.15 + 250 * 0.47) / 1e6;
		const haiku = (1500 * 0.1 + 250 * 0.5) / 1e6;
		expect(estimateJudgeUsd(judges, profile)).toBeCloseTo(2 * (qwen + haiku), 12);
		// antes eram 3000 de entrada e 500 de saída fixos (~4,7x o real)
		expect(estimateJudgeUsd(judges.slice(0, 1), { ...profile, judge: { calls: 1, promptTokens: 700 } })).toBeCloseTo((700 * 0.15 + 250 * 0.47) / 1e6, 12);
		expect(JUDGE_COMPLETION_TOKENS).toBe(250);
	});

	it("buildEstimate soma as chamadas e os tokens do juiz do perfil de cada cenário", () => {
		const scenario = make();
		const engines = resolveEngines(["v2"]);
		const models = ["anthropic/claude-sonnet-5-5", "opencode-go/qwen3.8-flash"].map(resolveModelSpec);
		const judges = [resolveModelSpec("anthropic/claude-haiku-5-5")];
		const profiles = new Map<string, ExecutionProfile>([[profileKey("j", "v2"), { modelCalls: 1, promptTokens: 1000, completionTokens: 100, fromMock: true, judge: { calls: 1, promptTokens: 900 } }]]);
		const estimate = buildEstimate({ scenarios: [scenario], engines, models, repeat: 3, profiles, factor: 1, judges });
		const row = estimate.judgeRows[0]!;
		expect(row).toMatchObject({ calls: 6, promptTokens: 5400, completionTokens: 1500 });
		expect(row.usd).toBeCloseTo(6 * ((900 * 0.1 + 250 * 0.5) / 1e6), 12);
	});

	it("mock que errou ou que não chamou o modelo não vira estimativa 0: cai no perfil de reserva", () => {
		const scenario = make();
		expect(profileFromMock(scenario, trajectoryOf("", { error: "boom", tokens: { prompt: 0, completion: 0 } }))).toMatchObject({ modelCalls: FALLBACK_PROFILE.modelCalls, promptTokens: FALLBACK_PROFILE.promptTokens, fromMock: false });
		expect(profileFromMock(scenario, trajectoryOf("", { modelCalls: [], tokens: { prompt: 0, completion: 0 } }))).toMatchObject({ promptTokens: FALLBACK_PROFILE.promptTokens, fromMock: false });
		const ok = profileFromMock(scenario, trajectoryOf("pronto"));
		expect(ok).toMatchObject({ modelCalls: 1, promptTokens: 4000, completionTokens: 200, fromMock: true });
		const price = priceFor("anthropic/claude-sonnet-5-5").price;
		const failed = profileFromMock(scenario, trajectoryOf("", { error: "boom", tokens: { prompt: 0, completion: 0 } }));
		expect(estimateExecutionUsd(failed, price, 1)).toBeGreaterThan(estimateExecutionUsd(ok, price, 1));
	});

	it("profileScenarios: runtime do mock que falha vira perfil de reserva (e o juiz do cenário continua medido)", async () => {
		const scenario = make();
		const broken = { id: "quebrado", description: "mock sempre erra", patchScenario: (item: Scenario) => item, runOptions: () => ({ streamChat: (async () => { throw new Error("boom"); }) as never }) };
		const profiles = await profileScenarios([scenario], [broken], {});
		const profile = profiles.get(profileKey("j", "quebrado"))!;
		expect(profile).toMatchObject({ modelCalls: FALLBACK_PROFILE.modelCalls, fromMock: false });
		expect(profile.judge!.calls).toBe(1);
		expect(profile.judge!.promptTokens).toBeGreaterThan(300);
	});

	it("cenário sem roteiro usa o perfil de reserva", async () => {
		const noMock = make({ mock: undefined });
		const profiles = await profileScenarios([noMock], resolveEngines(["v2"]), {});
		expect(profiles.get(profileKey("j", "v2"))).toMatchObject({ promptTokens: FALLBACK_PROFILE.promptTokens, fromMock: false });
	});
});

describe("erros de execução não são falha do modelo (auditoria F0, C1)", () => {
	const strong = "anthropic/claude-sonnet-5-5";
	const cheap = "opencode-go/deepseek-v4.1-flash";
	const options = { engines: ["v2"], models: [strong, cheap], scenarios: [{ id: "s1", capability: "email" }], repeat: 4, mode: "real" as const, isStrong: strongMatcher(), createdAt: "2026-11-05T00:00:00.000Z" };
	const timeout = (repeat: number) => run({ model: cheap, provider: "opencode-go", repeat, pass: false, failedChecks: ["completed"], error: "First event or idle timeout", errorKind: "runtime_timeout" });
	const provider = (repeat: number) => run({ model: cheap, provider: "opencode-go", repeat, pass: false, failedChecks: ["completed"], error: "HTTP 429", errorKind: "provider" });
	const cheapOk = (repeat: number) => run({ model: cheap, provider: "opencode-go", repeat });
	const strongOk = [0, 1, 2, 3].map((repeat) => run({ model: strong, repeat }));

	it("agrega acerto de todas as execuções, acerto sem erros de execução e contagem por tipo", () => {
		const summary = summarizeMatrix([...strongOk, cheapOk(0), cheapOk(1), timeout(2), provider(3)], options);
		const agg = summary.byModel.v2![cheap]!;
		expect(agg).toMatchObject({ runs: 4, passes: 2, errors: 2, errorKinds: { runtime_timeout: 1, provider: 1 } });
		expect(passRateOf(agg)).toBe(0.5);
		expect(cleanRunsOf(agg)).toBe(2);
		expect(cleanPassRateOf(agg)).toBe(1);
		expect(summary.byModel.v2![strong]!.errorKinds).toEqual({ runtime_timeout: 0, provider: 0 });
	});

	it("o barato que só deu timeout não vira 'modelo' na leitura; o relatório diz o que foi desconsiderado", () => {
		const runs = [...strongOk, timeout(0), timeout(1), timeout(2), timeout(3)];
		const summary = summarizeMatrix(runs, options);
		// Antes: forte 4/4 + barato 0/4 = "modelo". Agora o barato não tem execução limpa.
		expect(summary.readings.s1!.v2!.verdict).not.toBe("modelo");
		expect(summary.readings.s1!.v2!.reason).toContain("desconsiderado: 4 corte de tempo do runtime");
	});

	it("falha real do modelo continua 'modelo' mesmo com timeouts misturados", () => {
		const wrong = (repeat: number) => run({ model: cheap, provider: "opencode-go", repeat, pass: false, failedChecks: ["tool_called"] });
		const summary = summarizeMatrix([...strongOk, wrong(0), wrong(1), timeout(2), timeout(3)], options);
		expect(summary.readings.s1!.v2!.verdict).toBe("modelo");
		expect(summary.readings.s1!.v2!.reason).toContain("desconsiderado: 2 corte de tempo do runtime");
	});

	it("tudo em erro de execução = 'erro de execução', não 'harness' nem 'modelo'", () => {
		const allTimeouts = [0, 1, 2, 3].flatMap((repeat) => [run({ model: strong, repeat, pass: false, failedChecks: ["completed"], error: "tempo esgotado (180s)", errorKind: "runtime_timeout" as const }), timeout(repeat)]);
		const summary = summarizeMatrix(allTimeouts, options);
		expect(summary.readings.s1!.v2!.verdict).toBe("erro de execução");
		expect(summary.readings.s1!.v2!.reason).toContain("não diz nada sobre o modelo");
	});

	it("o matrix.md mostra as duas colunas de acerto, as contagens por tipo e o corte de tempo como defeito do runtime", () => {
		const markdown = formatMatrixReport(summarizeMatrix([...strongOk, cheapOk(0), cheapOk(1), timeout(2), provider(3)], options));
		expect(markdown).toContain("acerto sem erros de execução");
		expect(markdown).toMatch(/opencode-go\/deepseek-v4\.1-flash \| 50% \(2\/4\) \| 100% \(2\/2\) \| 1 corte de tempo do runtime, 1 erro do provedor \|/);
		expect(markdown).toContain("**Corte de tempo do runtime:** 1 em `opencode-go/deepseek-v4.1-flash` (v2)");
		expect(markdown).toContain("defeito do harness");
	});

	it("sem erros de execução não há aviso de runtime", () => {
		expect(formatMatrixReport(summarizeMatrix([...strongOk, cheapOk(0)], options))).not.toContain("**Corte de tempo do runtime:**");
	});
});

describe("aviso de juiz inválido no relatório (auditoria F0, B2)", () => {
	const strong = "anthropic/claude-sonnet-5-5";
	const cheap = "opencode-go/qwen3.8-flash";
	const quality = (status: "scored" | "invalid") => ({ status, score: status === "scored" ? 4 : null, judges: 2, dimsCompared: 0, dimsDisputed: 0, dims: { completude: null, fontes: null, formato: null, antecipacao: null } });
	const build = (cheapStatus: "scored" | "invalid") =>
		summarizeMatrix([run({ model: strong, quality: quality("scored") }), run({ model: cheap, provider: "opencode-go", quality: quality(cheapStatus) }), run({ model: cheap, provider: "opencode-go", repeat: 1, quality: quality(cheapStatus) })], {
			engines: ["v2"],
			models: [strong, cheap],
			scenarios: [{ id: "s1", capability: "email" }],
			repeat: 2,
			mode: "simulate",
			judging: { models: ["anthropic/claude-haiku-5-5", "opencode-go/qwen3.8-flash"], maxGap: 1 },
			isStrong: strongMatcher(),
			createdAt: "2026-11-05T00:00:00.000Z",
		});

	it("quando TODOS os julgamentos de um modelo são inválidos, o matrix.md avisa no topo e por célula", () => {
		const markdown = formatMatrixReport(build("invalid"));
		expect(markdown).toContain("**Juiz inválido em tudo:** 2 de 2 julgamentos de `opencode-go/qwen3.8-flash` (v2)");
		expect(markdown).toContain("Sem nota em `s1` · v2 · `opencode-go/qwen3.8-flash`: 2 julgamento(s), todos inválidos.");
		expect(markdown).not.toContain(`julgamentos de \`${strong}\``);
	});

	it("sem inválidos totais não há aviso", () => {
		expect(formatMatrixReport(build("scored"))).not.toContain("Juiz inválido em tudo");
	});
});

describe("ouro × genérico lado a lado (04-avaliacao §1.1)", () => {
	const model = "anthropic/claude-sonnet-5-5";
	const scenarios = [
		{ id: "g1", capability: "email", tags: ["gold", "email"] },
		{ id: "g2", capability: "email", tags: ["gold", "email"] },
		{ id: "x1", capability: "email", tags: ["generic", "email"] },
		{ id: "x2", capability: "email", tags: ["generic", "email"] },
		{ id: "seed", capability: "geral", tags: ["rotinas"] },
	];
	const options = { engines: ["v2"], models: [model], repeat: 1, mode: "simulate" as const, isStrong: strongMatcher(), createdAt: "2026-11-05T00:00:00.000Z" };
	const runs: MatrixRun[] = [
		...cellRuns("g1", "email", model, "v2", [true]),
		...cellRuns("g2", "email", model, "v2", [true]),
		...cellRuns("x1", "email", model, "v2", [true]),
		...cellRuns("x2", "email", model, "v2", [false]),
		...cellRuns("seed", "geral", model, "v2", [false]),
	];

	it("com os dois conjuntos: acerto de cada um por motor × modelo, sem misturar semente", () => {
		const summary = summarizeMatrix(runs, { ...options, scenarios });
		expect(summary.bySet!.gold!.v2![model]).toMatchObject({ runs: 2, passes: 2 });
		expect(summary.bySet!.generic!.v2![model]).toMatchObject({ runs: 2, passes: 1 });
		const markdown = formatMatrixReport(summary);
		expect(markdown).toContain("### Ouro × genérico");
		expect(markdown).toMatch(new RegExp(`\\| v2 \\| ${model} \\| 100% \\(2/2\\) \\| 50% \\(1/2\\) \\| -50 \\|`));
	});

	it("com um conjunto só (ou nenhum), a seção não aparece e o resumo antigo segue igual", () => {
		for (const only of [scenarios.filter((item) => item.tags.includes("gold")), scenarios.filter((item) => item.tags.includes("generic")), scenarios.filter((item) => item.id === "seed")]) {
			const summary = summarizeMatrix(runs, { ...options, scenarios: only });
			expect(summary.bySet).toBeUndefined();
			expect(formatMatrixReport(summary)).not.toContain("Ouro × genérico");
		}
	});
});
