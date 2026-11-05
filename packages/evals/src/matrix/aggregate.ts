import { diagnose, type ModelStat, type Verdict } from "../verdict.js";

/** Agregação do relatório do matrix (funções puras sobre as execuções). */

export type MatrixRun = {
	scenarioId: string;
	capability: string;
	engine: string;
	/** Rótulo (`--models`). */
	model: string;
	provider: string;
	repeat: number;
	status: "done" | "skipped_budget";
	pass: boolean;
	failedChecks: string[];
	error?: string;
	steps: number;
	promptTokens: number;
	completionTokens: number;
	costUsd: number;
	costUnknown: boolean;
	durationMs: number;
	/** Estimativa usada na reserva do teto. */
	estimatedUsd: number;
};

export type Agg = {
	runs: number;
	passes: number;
	errors: number;
	skipped: number;
	failing: Record<string, number>;
	steps: number;
	promptTokens: number;
	completionTokens: number;
	costUsd: number;
	costUnknown: boolean;
	durationMs: number;
};

const emptyAgg = (): Agg => ({ runs: 0, passes: 0, errors: 0, skipped: 0, failing: {}, steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, costUnknown: false, durationMs: 0 });

function add(agg: Agg, run: MatrixRun): void {
	if (run.status === "skipped_budget") {
		agg.skipped += 1;
		return;
	}
	agg.runs += 1;
	if (run.pass) agg.passes += 1;
	if (run.error) agg.errors += 1;
	for (const name of run.failedChecks) agg.failing[name] = (agg.failing[name] ?? 0) + 1;
	agg.steps += run.steps;
	agg.promptTokens += run.promptTokens;
	agg.completionTokens += run.completionTokens;
	agg.costUsd += run.costUsd;
	agg.costUnknown ||= run.costUnknown;
	agg.durationMs += run.durationMs;
}

/** Capacidade = pasta do conjunto ouro (`gold/<capacidade>/`), que é a 2ª tag; fora do ouro, a 1ª tag. */
export function capabilityOf(tags: readonly string[]): string {
	return (tags[0] === "gold" ? tags[1] : tags[0]) ?? "geral";
}

type Grid = Record<string, Record<string, Record<string, Agg>>>;
const slot = (grid: Grid, a: string, b: string, c: string): Agg => ((grid[a] ??= {})[b] ??= {})[c] ??= emptyAgg();

export type EngineDelta = { engine: string; base: string; model: string; basePassRate: number | null; passRate: number | null; deltaPp: number | null };

export type MatrixSummary = {
	v: 1;
	createdAt: string;
	mode: "real" | "simulate";
	engines: string[];
	models: string[];
	repeat: number;
	capUsd: number | null;
	spentUsd: number;
	judgeUsd: number;
	skippedBudget: number;
	budgetStopped: boolean;
	costUnknown: boolean;
	scenarios: Array<{ id: string; capability: string }>;
	/** cenário → motor → modelo. */
	cells: Grid;
	/** capacidade → motor → modelo. */
	byCapability: Grid;
	/** motor → modelo (agregado de todos os cenários). */
	byModel: Record<string, Record<string, Agg>>;
	byProvider: Record<string, { runs: number; costUsd: number; costUnknown: boolean; promptTokens: number; completionTokens: number }>;
	/** cenário → motor → leitura "modelo ou harness" (ver 04-avaliacao §3). */
	readings: Record<string, Record<string, { verdict: Verdict; reason: string }>>;
	engineDeltas: EngineDelta[];
};

export const passRateOf = (agg: Pick<Agg, "runs" | "passes">): number | null => (agg.runs === 0 ? null : agg.passes / agg.runs);

export function summarizeMatrix(
	runs: readonly MatrixRun[],
	options: { engines: string[]; models: string[]; scenarios: Array<{ id: string; capability: string }>; repeat: number; mode: "real" | "simulate"; capUsd?: number; judgeUsd?: number; isStrong: (model: string) => boolean; createdAt?: string },
): MatrixSummary {
	const cells: Grid = {};
	const byCapability: Grid = {};
	const byModel: Record<string, Record<string, Agg>> = {};
	const byProvider: MatrixSummary["byProvider"] = {};
	for (const run of runs) {
		add(slot(cells, run.scenarioId, run.engine, run.model), run);
		add(slot(byCapability, run.capability, run.engine, run.model), run);
		add(((byModel[run.engine] ??= {})[run.model] ??= emptyAgg()), run);
		if (run.status === "done") {
			const provider = (byProvider[run.provider] ??= { runs: 0, costUsd: 0, costUnknown: false, promptTokens: 0, completionTokens: 0 });
			provider.runs += 1;
			provider.costUsd += run.costUsd;
			provider.costUnknown ||= run.costUnknown;
			provider.promptTokens += run.promptTokens;
			provider.completionTokens += run.completionTokens;
		}
	}
	const readings: MatrixSummary["readings"] = {};
	for (const scenario of options.scenarios) {
		for (const engine of options.engines) {
			const stats: ModelStat[] = options.models.map((model) => {
				const agg = cells[scenario.id]?.[engine]?.[model] ?? emptyAgg();
				return { model, runs: agg.runs, passes: agg.passes, errors: agg.errors, failing: agg.failing, costUsd: agg.costUsd, costUnknown: agg.costUnknown };
			});
			(readings[scenario.id] ??= {})[engine] = diagnose(stats, options.isStrong);
		}
	}
	const [baseEngine, ...otherEngines] = options.engines;
	const engineDeltas: EngineDelta[] = [];
	for (const engine of otherEngines) {
		for (const model of options.models) {
			const base = passRateOf(byModel[baseEngine!]?.[model] ?? emptyAgg());
			const rate = passRateOf(byModel[engine]?.[model] ?? emptyAgg());
			engineDeltas.push({ engine, base: baseEngine!, model, basePassRate: base, passRate: rate, deltaPp: base === null || rate === null ? null : Math.round((rate - base) * 100) });
		}
	}
	const skippedBudget = runs.filter((run) => run.status === "skipped_budget").length;
	const spentUsd = runs.reduce((sum, run) => sum + run.costUsd, 0) + (options.judgeUsd ?? 0);
	return {
		v: 1,
		createdAt: options.createdAt ?? new Date().toISOString(),
		mode: options.mode,
		engines: options.engines,
		models: options.models,
		repeat: options.repeat,
		capUsd: options.capUsd ?? null,
		spentUsd,
		judgeUsd: options.judgeUsd ?? 0,
		skippedBudget,
		budgetStopped: skippedBudget > 0,
		costUnknown: runs.some((run) => run.costUnknown),
		scenarios: options.scenarios,
		cells,
		byCapability,
		byModel,
		byProvider,
		readings,
		engineDeltas,
	};
}
