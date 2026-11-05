import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEvaluation } from "../runner.js";
import { loadScenarios, type Scenario } from "../scenario.js";
import { createJudgePanel, createRubricJudge } from "../judge.js";
import { DIMENSIONS } from "../quality.js";
import { strongMatcher } from "../verdict.js";
import { buildEstimate, formatEstimate, profileScenarios } from "./estimate.js";
import { resolveEngines } from "./engines.js";
import { resolveModelSpecs } from "./models.js";
import type { MatrixProviders } from "./providers.js";
import { runMatrix } from "./run.js";

/** Rubrica de 2 juízes na matriz: juízes simulados ou falsos injetados, sem rede e sem chave. */

const SCENARIOS_DIR = fileURLToPath(new URL("../../scenarios", import.meta.url));
const MODELS = ["anthropic/claude-sonnet-5-5", "opencode-go/qwen3.8-flash"];
const JUDGES = ["anthropic/claude-haiku-5-5", "opencode-go/deepseek-v4.1-flash"];
const dirs: string[] = [];
let scenarios: Scenario[] = [];
let judged: Scenario[] = [];

beforeAll(async () => {
	const all = await loadScenarios(SCENARIOS_DIR, { recursive: true });
	judged = ["gold-email-resumo-24h", "gold-pesquisa-10-fornecedores-com-fonte", "gold-dia-planejar-meu-dia"].map((id) => all.find((scenario) => scenario.id === id)!);
	scenarios = [...judged, all.find((scenario) => scenario.id === "gold-agenda-lembrete-boleto-amanha-10h")!];
	expect(scenarios.every(Boolean)).toBe(true);
});
afterAll(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
const tmp = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "evals-judge-"));
	dirs.push(dir);
	return dir;
};

/** Juiz falso por provedor: responde o JSON fixo e devolve tokens (o custo sai da tabela de preços). */
function fakeJudgeProviders(answers: { anthropic: Record<string, number | null>; go: Record<string, number | null> }, counter: { calls: number }): MatrixProviders {
	const body = (scores: Record<string, number | null>) => JSON.stringify(Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, { score: scores[dimension] ?? 4, reason: "teste" }])));
	const make = (scores: Record<string, number | null>) => (async (params: { model: string }) => {
		counter.calls += 1;
		return { model: params.model, message: { role: "assistant", content: body(scores) }, usage: { promptTokens: 3000, completionTokens: 300, totalTokens: 3300 } };
	}) as unknown as MatrixProviders["anthropic"];
	const refuse = (async () => {
		throw new Error("provedor não deveria ser chamado");
	}) as unknown as MatrixProviders["anthropic"];
	return { anthropic: make(answers.anthropic), opencodeGo: make(answers.go), openrouter: refuse };
}

describe("matrix --simulate com dois juízes", () => {
	it("o relatório traz colunas de qualidade e a taxa de discordância; sem --judge nada aparece", async () => {
		const outDir = await tmp();
		const result = await runMatrix({ scenarios: judged, engines: ["v2"], models: MODELS, repeat: 2, mode: "simulate", judgeModels: JUDGES, capUsd: 100, isStrong: strongMatcher(), outDir, now: () => new Date("2026-11-05T12:00:00Z") });
		const { summary, markdown } = result;
		expect(summary.judging).toEqual({ models: JUDGES, maxGap: 1 });
		expect(summary.judgeUsd).toBeGreaterThan(0);
		expect(summary.spentUsd).toBeGreaterThan(summary.judgeUsd);
		const quality = summary.byModel.v2![MODELS[0]!]!.quality;
		expect(quality.judged).toBe(6); // 3 cenários com juiz × 2 repetições
		expect(quality.dimsCompared).toBeGreaterThan(0);
		for (const section of ["### Qualidade (rubrica) por modelo", "## Qualidade por capacidade", "Rubrica de qualidade (1 a 5): 2 juiz(es)", "dimensões em disputa", "teto de discordância 1"]) expect(markdown).toContain(section);
		expect(result.runs.every((run) => run.quality?.judges === 2)).toBe(true);
		expect(JSON.parse(await readFile(join(outDir, "matrix.json"), "utf8")).summary.judging.models).toEqual(JUDGES);
		const plain = await runMatrix({ scenarios: judged, engines: ["v2"], models: MODELS, repeat: 1, mode: "simulate", isStrong: strongMatcher() });
		expect(plain.summary.judging).toBeNull();
		expect(plain.summary.judgeUsd).toBe(0);
		expect(plain.markdown).not.toContain("Qualidade");
		expect(plain.runs.every((run) => run.quality === undefined)).toBe(true);
	}, 120_000);

	it("só os cenários com verificação judge são julgados", async () => {
		const result = await runMatrix({ scenarios, engines: ["v2"], models: [MODELS[0]!], repeat: 1, mode: "simulate", judgeModels: JUDGES, isStrong: strongMatcher() });
		const agenda = result.runs.find((run) => run.scenarioId === "gold-agenda-lembrete-boleto-amanha-10h")!;
		expect(agenda.quality).toBeUndefined();
		expect(result.runs.filter((run) => run.quality)).toHaveLength(3);
	}, 60_000);

	it("é determinístico e respeita o teto de discordância configurável", async () => {
		const base = { scenarios: judged, engines: ["v2"], models: MODELS, repeat: 3, mode: "simulate" as const, judgeModels: JUDGES, isStrong: strongMatcher() };
		const [a, b] = [await runMatrix(base), await runMatrix(base)];
		const key = (items: typeof a.runs) => items.map((run) => `${run.scenarioId}|${run.model}|${run.repeat}|${run.quality?.score}|${run.quality?.dimsDisputed}`);
		expect(key(a.runs)).toEqual(key(b.runs));
		const loose = await runMatrix({ ...base, judgeMaxGap: 4 });
		expect(loose.runs.every((run) => run.quality!.dimsDisputed === 0)).toBe(true);
		const strict = await runMatrix({ ...base, judgeMaxGap: 0 });
		const disputed = (items: typeof a.runs) => items.reduce((sum, run) => sum + (run.quality?.dimsDisputed ?? 0), 0);
		expect(disputed(strict.runs)).toBeGreaterThanOrEqual(disputed(a.runs));
		expect(disputed(a.runs)).toBeGreaterThan(0);
	}, 120_000);

	it("o custo do juiz entra no teto: a reserva sobe e uma rodada que cabia sem juiz é cortada", async () => {
		const options = { scenarios: judged.slice(0, 1), engines: ["v2"], models: [MODELS[0]!], repeat: 1, mode: "simulate" as const, isStrong: strongMatcher() };
		const without = await runMatrix(options);
		const withJudges = await runMatrix({ ...options, judgeModels: JUDGES });
		const [estWithout, estWith] = [without.runs[0]!.estimatedUsd, withJudges.runs[0]!.estimatedUsd];
		expect(estWith).toBeGreaterThan(estWithout);
		// Teto entre as duas reservas: sem juiz roda, com juiz o teto é atingido antes de começar.
		const capUsd = (estWithout + estWith) / 2;
		expect((await runMatrix({ ...options, capUsd })).runs[0]!.status).toBe("done");
		const capped = await runMatrix({ ...options, judgeModels: JUDGES, capUsd });
		expect(capped.runs[0]!.status).toBe("skipped_budget");
		expect(capped.summary.budgetStopped).toBe(true);
		expect(capped.markdown).toContain("Teto atingido");
	}, 60_000);

	it("o gasto real do juiz é cobrado do mesmo teto e nunca passa dele", async () => {
		const options = { scenarios: judged, engines: ["v2"], models: [MODELS[0]!], repeat: 3, mode: "simulate" as const, judgeModels: JUDGES, isStrong: strongMatcher(), concurrency: 1 };
		const full = await runMatrix(options);
		expect(full.summary.judgeUsd).toBeGreaterThan(0);
		const capUsd = full.summary.spentUsd * 0.6;
		const capped = await runMatrix({ ...options, capUsd });
		expect(capped.summary.spentUsd).toBeLessThanOrEqual(capUsd);
		expect(capped.summary.spentUsd).toBeGreaterThan(0);
	}, 120_000);

	it("recusa mais de 2 juízes e gap negativo", async () => {
		const base = { scenarios: judged.slice(0, 1), engines: ["v2"], models: [MODELS[0]!], mode: "simulate" as const, isStrong: strongMatcher() };
		await expect(runMatrix({ ...base, judgeModels: [...JUDGES, "openrouter/x/y"] })).rejects.toThrow(/no máximo 2/);
		await expect(runMatrix({ ...base, judgeModels: JUDGES, judgeMaxGap: -1 })).rejects.toThrow(/judge-max-gap/);
	});
});

describe("matrix real com juízes injetados", () => {
	const env = { CLAUDE_KEY: "k-a", OPENCODE_GO_API_KEY: "k-b" };
	const scripted = (counter: { calls: number }): MatrixProviders => ({
		...fakeJudgeProviders({ anthropic: {}, go: {} }, counter),
	});

	it("juízes de provedores diferentes concordando/discordando; cada um é chamado uma vez por execução julgada", async () => {
		const counter = { calls: 0 };
		const providers: MatrixProviders = fakeJudgeProviders({ anthropic: { completude: 5, fontes: 5, formato: 4, antecipacao: 4 }, go: { completude: 2, fontes: 4, formato: 4, antecipacao: 4 } }, counter);
		// O modelo avaliado usa os mesmos provedores falsos (responde o JSON da rubrica como texto): a execução pode falhar nas
		// verificações, o que importa aqui é a conta dos juízes.
		const result = await runMatrix({ scenarios: judged.slice(0, 1), engines: ["v2"], models: ["anthropic/claude-sonnet-5-5"], repeat: 1, mode: "real", capUsd: 50, env, providers, judgeModels: JUDGES, isStrong: strongMatcher() });
		const run = result.runs[0]!;
		// pelo menos 1 chamada do agente + 2 de juiz
		expect(counter.calls).toBeGreaterThanOrEqual(2);
		expect(run.quality).toMatchObject({ judges: 2, dimsCompared: 4, dimsDisputed: 1 });
		expect(result.summary.judgeUsd).toBeGreaterThan(0);
	}, 60_000);

	it("falta a chave do provedor de um juiz: falha antes de qualquer execução, citando só a variável", async () => {
		const counter = { calls: 0 };
		await expect(runMatrix({ scenarios: judged.slice(0, 1), engines: ["v2"], models: ["anthropic/claude-sonnet-5-5"], mode: "real", capUsd: 5, env: { CLAUDE_KEY: "sk-secret" }, providers: scripted(counter), judgeModels: JUDGES, isStrong: strongMatcher() })).rejects.toThrow(/OPENCODE_GO_API_KEY/);
		expect(counter.calls).toBe(0);
	});
});

describe("--estimate com juízes", () => {
	it("soma as chamadas dos juízes ao total e ao encaixe no teto", async () => {
		const engines = resolveEngines(["v2"]);
		const models = resolveModelSpecs(MODELS);
		const judges = resolveModelSpecs(JUDGES);
		const profiles = await profileScenarios(judged, engines);
		const base = { scenarios: judged, engines, models, repeat: 2, profiles, factor: 2 };
		const without = buildEstimate(base);
		const withJudges = buildEstimate({ ...base, judges });
		expect(without.judgeRows).toEqual([]);
		expect(withJudges.judgeRows).toHaveLength(2);
		expect(withJudges.judgeRows[0]!.calls).toBe(3 * 1 * 2 * 2); // 3 cenários julgados × 1 motor × 2 modelos × 2 repetições
		expect(withJudges.totalUsd).toBeCloseTo(without.totalUsd + withJudges.judgeRows.reduce((sum, row) => sum + row.usd, 0), 10);
		expect(withJudges.totalUsd).toBeGreaterThan(without.totalUsd);
		const cap = without.totalUsd * 1.01;
		expect(buildEstimate({ ...base, judges, capUsd: cap }).fitsInCap!.executions).toBeLessThan(buildEstimate({ ...base, capUsd: cap }).fitsInCap!.executions);
		expect(formatEstimate(withJudges)).toContain("juiz");
	}, 60_000);
});

describe("run: runEvaluation com painel de juízes falsos", () => {
	it("a linha de qualidade entra no relatório e o custo dos juízes conta no teto", async () => {
		const answer = JSON.stringify(Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, { score: 4, reason: "ok" }])));
		let judgeCalls = 0;
		const fake = createRubricJudge({ model: "f", apiKey: "x", streamChat: (async () => (judgeCalls++, { model: "f", message: { role: "assistant", content: answer } })) as never });
		const result = await runEvaluation({ scenarios: judged, models: [], mode: "mock", judge: createJudgePanel({ judges: [fake, fake] }), judgeCostUsd: () => 0, isStrong: strongMatcher() });
		expect(judgeCalls).toBe(6); // 3 cenários × 2 juízes
		expect(result.report).toContain("qualidade (rubrica): 3 julgada(s)");
		expect(result.records.every((record) => record.checks.find((check) => check.name.includes("rubrica"))?.quality?.status === "scored")).toBe(true);
		const capped = await runEvaluation({ scenarios: judged, models: [], mode: "mock", judge: createJudgePanel({ judges: [fake] }), judgeCostUsd: () => 99, maxCostUsd: 1, isStrong: strongMatcher(), concurrency: 1 });
		expect(capped.skippedByBudget).toBeGreaterThan(0);
	}, 60_000);
});
