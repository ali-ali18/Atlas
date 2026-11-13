import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMatrix } from "./run.js";
import type { MatrixProviders } from "./providers.js";
import type { EngineAdapter } from "./engines.js";
import { loadScenarios, type Scenario } from "../scenario.js";
import { strongMatcher } from "../verdict.js";

/**
 * Teto de gasto durante a execução (auditoria F0, S3): o gasto real é cobrado a cada chamada, o estouro interrompe as
 * execuções em andamento e o excesso fica limitado às chamadas que já estavam em voo. Provedor falso, sem rede.
 */

const SCENARIOS_DIR = fileURLToPath(new URL("../../scenarios", import.meta.url));
const MODEL = "openrouter/vendor/caro";
const CALL_USD = 0.3;
let scenario: Scenario;
const dirs: string[] = [];

beforeAll(async () => {
	scenario = (await loadScenarios(SCENARIOS_DIR, { recursive: true })).find((item) => item.id === "gold-email-resumo-24h")!;
	expect(scenario).toBeDefined();
});
afterAll(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const tmp = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "evals-budget-"));
	dirs.push(dir);
	return dir;
};

type Fake = { providers: MatrixProviders; mainCalls: () => number; maxInFlight: () => number };

/** OpenRouter falso: cada chamada principal custa CALL_USD (a barata, sem tools, é grátis). `latency(n)` é o atraso da n-ésima chamada principal. */
function fake(latency: (n: number) => number, options: { honorAbort?: boolean } = {}): Fake {
	let mains = 0;
	let inFlight = 0;
	let peak = 0;
	const openrouter: MatrixProviders["openrouter"] = async (params) => {
		if (params.tools.length === 0) return { model: params.model, message: { role: "assistant", content: '{"promisesFile": false, "fixFile": false}' }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0 } };
		mains += 1;
		const n = mains;
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, latency(n));
				if (options.honorAbort) params.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("aborted"))), { once: true });
			});
		} finally {
			inFlight -= 1;
		}
		return { model: params.model, finishReason: "stop", message: { role: "assistant", content: "Resumo dos seus e-mails: nada urgente." }, usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: CALL_USD } };
	};
	const never = (async () => {
		throw new Error("provedor não usado");
	}) as MatrixProviders["anthropic"];
	return { providers: { anthropic: never, opencodeGo: never, openrouter }, mainCalls: () => mains, maxInFlight: () => peak };
}

const base = { engines: ["v2"], models: [MODEL], mode: "real" as const, env: { OPENROUTER_API_KEY: "k" }, isStrong: strongMatcher() };

describe("teto durante a execução (auditoria F0, S3)", () => {
	it("concorrência 3 com provedor caro: o gasto não passa do teto por mais que uma chamada por execução em andamento", async () => {
		const provider = fake(() => 15);
		const capUsd = 1;
		const concurrency = 3;
		const result = await runMatrix({ ...base, scenarios: [scenario], repeat: 12, capUsd, concurrency, providers: provider.providers });
		const charged = provider.mainCalls() * CALL_USD;
		// Sem a cobrança por chamada, as 12 execuções rodariam (as estimativas são pequenas): 12 × 0,30 = 3,60.
		expect(provider.mainCalls()).toBeLessThan(12);
		expect(charged).toBeLessThan(capUsd + concurrency * CALL_USD);
		expect(charged).toBeGreaterThanOrEqual(capUsd);
		expect(provider.maxInFlight()).toBeLessThanOrEqual(concurrency);
		// O relatório diz o mesmo que o provedor cobrou.
		expect(result.summary.spentUsd).toBeCloseTo(charged, 8);
		const statuses = result.runs.map((run) => run.status);
		expect(statuses.filter((status) => status === "skipped_budget").length).toBeGreaterThan(0);
		expect(result.summary.budgetStopped).toBe(true);
		expect(result.summary.skippedBudget + result.summary.stoppedBudget + statuses.filter((status) => status === "done").length).toBe(12);
		expect(result.markdown).toContain("Teto atingido");
	}, 60_000);

	it("estouro com chamada em voo: a execução vira stopped_budget, o custo parcial entra e o excesso é só essa chamada", async () => {
		// chamadas principais 1 e 2 terminam logo (0,60 > teto 0,50); a 3ª, em voo, termina depois e ainda custa.
		const provider = fake((n) => (n === 1 ? 10 : n === 2 ? 40 : 300));
		const outDir = await tmp();
		const result = await runMatrix({ ...base, scenarios: [scenario], repeat: 3, capUsd: 0.5, concurrency: 3, providers: provider.providers, drainMs: 2000, outDir });
		const stopped = result.runs.filter((run) => run.status === "stopped_budget");
		expect(provider.mainCalls()).toBe(3);
		expect(stopped).toHaveLength(1);
		expect(stopped[0]!).toMatchObject({ pass: false, error: expect.stringContaining("teto de gasto atingido") });
		// o custo da chamada em voo foi cobrado mesmo depois do aborto
		expect(stopped[0]!.costUsd).toBeCloseTo(CALL_USD, 8);
		expect(result.summary.spentUsd).toBeCloseTo(3 * CALL_USD, 8);
		expect(result.summary.stoppedBudget).toBe(1);
		expect(result.summary.budgetStopped).toBe(true);
		// interrompida não vira reprovação do modelo
		const agg = result.summary.byModel.v2![MODEL]!;
		expect(agg).toMatchObject({ runs: 2, stopped: 1 });
		expect(agg.costUsd).toBeCloseTo(3 * CALL_USD, 8);
		expect(result.markdown).toContain("stopped_budget");
		expect(result.markdown).toContain("interrompido (1)");
		expect(await readFile(join(outDir, "matrix.md"), "utf8")).toContain("interrompidas em andamento");
	}, 60_000);

	it("provedor que respeita o aborto: execução interrompida sem cobrar o que não chegou a terminar", async () => {
		const provider = fake((n) => (n === 1 ? 10 : n === 2 ? 40 : 5000), { honorAbort: true });
		const result = await runMatrix({ ...base, scenarios: [scenario], repeat: 3, capUsd: 0.5, concurrency: 3, providers: provider.providers, drainMs: 500 });
		const stopped = result.runs.filter((run) => run.status === "stopped_budget");
		expect(stopped).toHaveLength(1);
		expect(stopped[0]!.costUsd).toBe(0);
		expect(result.summary.spentUsd).toBeCloseTo(2 * CALL_USD, 8);
	}, 60_000);

	it("estimativa que não cabe pula só aquela execução; a mais barata seguinte roda (não trava para sempre)", async () => {
		const provider = fake(() => 5);
		const heavy: Scenario = { ...scenario, id: "pesado", mock: { turns: [{ say: "x".repeat(40_000) }] } };
		// Mede as estimativas sem gastar nada: teto bem alto.
		const probe = await runMatrix({ ...base, scenarios: [heavy, scenario], repeat: 1, capUsd: 100, concurrency: 1, providers: fake(() => 1).providers });
		const estimate = Object.fromEntries(probe.runs.map((run) => [run.scenarioId, run.estimatedUsd]));
		expect(estimate.pesado).toBeGreaterThan(estimate["gold-email-resumo-24h"]! * 2);
		// Teto entre as duas: o pesado não cabe, o leve cabe.
		const capUsd = (estimate.pesado! + estimate["gold-email-resumo-24h"]!) / 2;
		expect(capUsd).toBeLessThan(estimate.pesado!);
		expect(capUsd).toBeGreaterThan(estimate["gold-email-resumo-24h"]!);
		const result = await runMatrix({ ...base, scenarios: [heavy, scenario], repeat: 1, capUsd, concurrency: 1, providers: provider.providers });
		const byId = Object.fromEntries(result.runs.map((run) => [run.scenarioId, run.status]));
		expect(byId).toEqual({ pesado: "skipped_budget", "gold-email-resumo-24h": "done" });
	}, 60_000);

	it("execução que lança depois de gastar registra o custo parcial (antes ficava US$ 0)", async () => {
		const provider = fake(() => 5);
		// O cenário vira inválido só depois da chamada ao modelo: a verificação lança ao avaliar a regex.
		const throwing: EngineAdapter = {
			id: "quebra",
			description: "verificação que lança",
			patchScenario: (item) => ({ ...item, expect: [{ type: "text_contains", pattern: "[", ignoreCase: false }] }),
		};
		const result = await runMatrix({ ...base, scenarios: [scenario], engines: ["quebra"], engineTable: { quebra: throwing }, repeat: 1, capUsd: 5, providers: provider.providers });
		const run = result.runs[0]!;
		expect(run).toMatchObject({ status: "done", pass: false, failedChecks: ["completed"] });
		expect(run.error).toBeTruthy();
		expect(run.costUsd).toBeCloseTo(CALL_USD, 8);
		expect(result.summary.spentUsd).toBeCloseTo(CALL_USD, 8);
	}, 60_000);
});
