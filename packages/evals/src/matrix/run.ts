import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "@workspace/shared";
import { passed, runChecks, type Judge } from "../checks.js";
import { createJudgePanel, createRubricJudge, type RubricJudge } from "../judge.js";
import { DEFAULT_MAX_GAP, summarizeRunQuality } from "../quality.js";
import type { StreamChat } from "../mock-model.js";
import { pool } from "../runner.js";
import { runScenario } from "../run-scenario.js";
import type { Scenario } from "../scenario.js";
import type { RunRecord } from "../trajectory.js";
import { classifyRunError } from "../error-kind.js";
import { capabilityOf, summarizeMatrix, type MatrixRun, type MatrixSummary } from "./aggregate.js";
import { BudgetGuard } from "./budget.js";
import { ENGINE_ADAPTERS, resolveEngines, type EngineAdapter } from "./engines.js";
import { DEFAULT_ESTIMATE_FACTOR, estimateExecutionUsd, estimateJudgeUsd, hasJudgeExpectation, profileKey, profileScenarios, FALLBACK_PROFILE, type ExecutionProfile } from "./estimate.js";
import { formatMatrixReport } from "./format.js";
import { assertProviderKeys, providerSecrets, resolveModelSpec, resolveModelSpecs, type ResolvedModel } from "./models.js";
import { priceFor, type PriceEntry } from "./pricing.js";
import { createMatrixRouter, createRealProviders, withCostAccounting, withSessionId, type MatrixProviders } from "./providers.js";
import { simulatedJudgeProviders, simulatedProviders } from "./simulate.js";

export type MatrixOptions = {
	scenarios: Scenario[];
	engines: string[];
	models: string[];
	repeat?: number;
	/** Teto RÍGIDO em US$ desta invocação. Obrigatório no modo real. */
	capUsd?: number;
	mode: "real" | "simulate";
	/** Variáveis de ambiente (chaves). Padrão: `process.env`. */
	env?: Record<string, string | undefined>;
	/** Provedores no modo real (teste injeta fakes); padrão: adaptadores reais do `packages/llm`. */
	providers?: MatrixProviders;
	concurrency?: number;
	timeoutMs?: number;
	estimateFactor?: number;
	/** Juízes da rubrica (1 ou 2 ids com prefixo de provedor). Sem eles, nenhum juiz roda. */
	judgeModels?: string[];
	/** Teto de discordância por dimensão (padrão 1). */
	judgeMaxGap?: number;
	isStrong: (model: string) => boolean;
	outDir?: string;
	now?: () => Date;
	engineTable?: Record<string, EngineAdapter>;
	priceTable?: Record<string, PriceEntry>;
	onProgress?: (run: MatrixRun, done: number, total: number) => void;
};

export type MatrixResult = { summary: MatrixSummary; runs: MatrixRun[]; records: RunRecord[]; markdown: string; outDir?: string };

type Job = { scenario: Scenario; engine: EngineAdapter; model: ResolvedModel; repeat: number; estimatedUsd: number };

export async function runMatrix(options: MatrixOptions): Promise<MatrixResult> {
	const now = options.now ?? (() => new Date());
	const env = options.env ?? process.env;
	const real = options.mode === "real";
	const repeat = Math.max(1, Math.floor(options.repeat ?? 1));
	const engines = resolveEngines(options.engines, options.engineTable ?? ENGINE_ADAPTERS);
	// Modelo repetido em `--models` contaria em dobro (execuções, gasto e acerto): vale a 1ª ocorrência.
	const models = resolveModelSpecs([...new Set(options.models.map((spec) => spec.trim()))]);
	if (models.length === 0) throw new Error("informe --models");
	if (options.scenarios.length === 0) throw new Error("nenhum cenário selecionado");
	if (real && options.capUsd === undefined) throw new Error("informe --max-usd: o modo real exige um teto de gasto rígido");
	const judgeModels = resolveModelSpecs(options.judgeModels ?? []);
	if (judgeModels.length > 2) throw new Error("--judge aceita no máximo 2 modelos");
	const judgeMaxGap = options.judgeMaxGap ?? DEFAULT_MAX_GAP;
	if (!(judgeMaxGap >= 0)) throw new Error("--judge-max-gap precisa ser 0 ou mais");
	const used = [...models, ...judgeModels];
	// Antes de qualquer execução: chave de cada provedor usado (inclusive o dos juízes).
	if (real) assertProviderKeys(used, env);
	const secrets = providerSecrets(used, env);
	const redact = (text: string): string => redactSecrets(text, secrets);

	const factor = options.estimateFactor ?? DEFAULT_ESTIMATE_FACTOR;
	const profiles = await profileScenarios(options.scenarios, engines, { concurrency: options.concurrency ?? 3 });
	const guard = new BudgetGuard(options.capUsd);
	const realProviders = real ? (options.providers ?? createRealProviders(env)) : undefined;
	let judgeUsd = 0;
	// O gasto do juiz sai do MESMO teto que as execuções (`guard.charge`).
	const rubricJudges: RubricJudge[] = judgeModels.map((judgeModel) => {
		const router = withCostAccounting(createMatrixRouter(realProviders ? withSessionId(realProviders, "matrix-judge") : simulatedJudgeProviders(judgeModel)), { ...(options.priceTable ? { table: options.priceTable } : {}), onCost: (usd) => guard.charge(usd) });
		return createRubricJudge({
			model: judgeModel.internalId,
			apiKey: "matrix",
			streamChat: (params) =>
				router(params, {}).then((result) => {
					judgeUsd += result.usage?.costUsd ?? 0;
					return result;
				}) as ReturnType<StreamChat>,
		});
	});
	const judge: Judge | undefined = rubricJudges.length > 0 ? createJudgePanel({ judges: rubricJudges, maxGap: judgeMaxGap }) : undefined;

	const jobs: Job[] = [];
	// Repetição por fora: se o teto cortar, as repetições já feitas cobrem todas as células.
	for (let index = 0; index < repeat; index += 1) {
		for (const scenario of options.scenarios) {
			for (const engine of engines) {
				for (const model of models) {
					const profile: ExecutionProfile = profiles.get(profileKey(scenario.id, engine.id)) ?? FALLBACK_PROFILE;
					jobs.push({ scenario, engine, model, repeat: index, estimatedUsd: estimateExecutionUsd(profile, priceFor(model.priceKey, options.priceTable).price, factor) + (hasJudgeExpectation(scenario) ? estimateJudgeUsd(judgeModels, profile, options.priceTable) : 0) });
				}
			}
		}
	}

	const runs: MatrixRun[] = [];
	const records: RunRecord[] = [];
	const outDir = options.outDir;
	if (outDir) await mkdir(outDir, { recursive: true });
	const runsFile = outDir ? join(outDir, "runs.jsonl") : undefined;
	const base = (job: Job) => ({ scenarioId: job.scenario.id, capability: capabilityOf(job.scenario.tags), engine: job.engine.id, model: job.model.spec, provider: job.model.provider, repeat: job.repeat, estimatedUsd: job.estimatedUsd });
	const emit = (run: MatrixRun): void => {
		runs.push(run);
		options.onProgress?.(run, runs.length, jobs.length);
	};

	await pool(jobs, options.concurrency ?? 3, async (job) => {
		if (!guard.tryReserve(job.estimatedUsd)) {
			emit({ ...base(job), status: "skipped_budget", pass: false, failedChecks: [], steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, costUnknown: false, durationMs: 0 });
			return;
		}
		let actual = 0;
		try {
			const providers = realProviders
				? withSessionId(realProviders, `matrix-${job.scenario.id}-${job.engine.id}-${job.repeat}`)
				: simulatedProviders({ scenario: job.scenario, engine: job.engine.id, model: job.model, repeat: job.repeat });
			const stream = withCostAccounting(createMatrixRouter(providers), options.priceTable ? { table: options.priceTable } : {});
			const patched = job.engine.patchScenario(job.scenario);
			const trajectory = await runScenario(patched, {
				model: job.model.internalId,
				// Marcador, não segredo: a chave real fica nos fechamentos dos provedores.
				apiKey: "matrix",
				streamChat: stream as unknown as StreamChat,
				variant: job.engine.id,
				repeat: job.repeat,
				...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
				...(job.engine.runOptions?.() ?? {}),
			});
			trajectory.model = job.model.spec;
			actual = trajectory.costUsd;
			const checks = await runChecks(patched, trajectory, judge ? { judge } : {});
			const quality = summarizeRunQuality(checks.map((item) => item.quality));
			const record: RunRecord = { scenarioId: job.scenario.id, model: job.model.spec, variant: job.engine.id, repeat: job.repeat, pass: passed(checks), checks, trajectory };
			records.push(record);
			if (runsFile) await appendFile(runsFile, `${redact(JSON.stringify(record))}\n`);
			emit({
				...base(job),
				status: "done",
				pass: record.pass && !trajectory.error,
				failedChecks: checks.filter((item) => !item.pass && !item.skipped).map((item) => item.name),
				...(quality ? { quality } : {}),
				...(trajectory.error ? { error: redact(trajectory.error).slice(0, 300) } : {}),
				...(classifyRunError(trajectory) ? { errorKind: classifyRunError(trajectory)! } : {}),
				steps: trajectory.modelCalls.filter((call) => call.kind === "main").length,
				promptTokens: trajectory.tokens.prompt,
				completionTokens: trajectory.tokens.completion,
				costUsd: trajectory.costUsd,
				costUnknown: trajectory.costUnknown,
				durationMs: trajectory.durationMs,
			});
		} catch (error) {
			emit({ ...base(job), status: "done", pass: false, failedChecks: ["completed"], error: redact(error instanceof Error ? error.message : "erro desconhecido").slice(0, 300), steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, costUnknown: false, durationMs: 0 });
		} finally {
			guard.settle(job.estimatedUsd, actual);
		}
	});

	// Ordem estável: a do agendamento, não a de término.
	const order = new Map(jobs.map((job, index) => [`${job.scenario.id}|${job.engine.id}|${job.model.spec}|${job.repeat}`, index]));
	runs.sort((a, b) => (order.get(`${a.scenarioId}|${a.engine}|${a.model}|${a.repeat}`) ?? 0) - (order.get(`${b.scenarioId}|${b.engine}|${b.model}|${b.repeat}`) ?? 0));
	const summary = summarizeMatrix(runs, {
		engines: engines.map((engine) => engine.id),
		models: models.map((model) => model.spec),
		scenarios: options.scenarios.map((scenario) => ({ id: scenario.id, capability: capabilityOf(scenario.tags), tags: scenario.tags })),
		repeat,
		mode: options.mode,
		...(options.capUsd !== undefined ? { capUsd: options.capUsd } : {}),
		judgeUsd,
		...(judgeModels.length > 0 ? { judging: { models: judgeModels.map((item) => item.spec), maxGap: judgeMaxGap } } : {}),
		isStrong: options.isStrong,
		createdAt: now().toISOString(),
	});
	const markdown = redact(formatMatrixReport(summary));
	if (outDir) {
		await writeFile(join(outDir, "matrix.json"), `${redact(JSON.stringify({ summary, runs }, null, 2))}\n`);
		await writeFile(join(outDir, "matrix.md"), `${markdown}\n`);
	}
	return { summary, runs, records, markdown, ...(outDir ? { outDir } : {}) };
}

/** Pasta padrão `<base>/<timestamp>-matrix`. */
export const defaultMatrixDir = (base: string, now: Date): string => join(base, `${now.toISOString().replace(/[:.]/g, "-")}-matrix`);
