import { ERROR_KINDS, ERROR_KIND_LABELS, type ErrorKind } from "../error-kind.js";
import { addQuality, emptyQualityAgg, type QualityAgg, type RunQuality } from "../quality.js";
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
	/** `skipped_budget`: não começou (a estimativa não coube ou o teto já tinha sido atingido). `stopped_budget`: começou e foi interrompida quando o teto foi atingido (custo parcial; sem nota de acerto). */
	status: "done" | "skipped_budget" | "stopped_budget";
	pass: boolean;
	failedChecks: string[];
	error?: string;
	/** Natureza do erro de execução (corte de tempo do runtime ou erro do provedor); ausente = sem erro, ou erro do modelo. */
	errorKind?: ErrorKind;
	steps: number;
	promptTokens: number;
	completionTokens: number;
	costUsd: number;
	costUnknown: boolean;
	durationMs: number;
	/** Estimativa usada na reserva do teto. */
	estimatedUsd: number;
	/** Rubrica de qualidade (só com `--judge` e cenário com verificação `judge`). */
	quality?: RunQuality;
};

export type Agg = {
	runs: number;
	passes: number;
	errors: number;
	/** Execuções por natureza do erro de execução: infraestrutura, não falha do modelo. */
	errorKinds: Record<ErrorKind, number>;
	skipped: number;
	/** Interrompidas em andamento pelo teto: o custo entra, mas não contam como execução nem como acerto. */
	stopped: number;
	failing: Record<string, number>;
	steps: number;
	promptTokens: number;
	completionTokens: number;
	costUsd: number;
	costUnknown: boolean;
	durationMs: number;
	/** Rubrica de qualidade das execuções julgadas. */
	quality: QualityAgg;
};

const emptyAgg = (): Agg => ({ runs: 0, passes: 0, errors: 0, errorKinds: { runtime_timeout: 0, provider: 0 }, skipped: 0, stopped: 0, failing: {}, steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, costUnknown: false, durationMs: 0, quality: emptyQualityAgg() });

function add(agg: Agg, run: MatrixRun): void {
	if (run.status === "skipped_budget") {
		agg.skipped += 1;
		return;
	}
	if (run.status === "stopped_budget") {
		agg.stopped += 1;
		agg.promptTokens += run.promptTokens;
		agg.completionTokens += run.completionTokens;
		agg.costUsd += run.costUsd;
		agg.costUnknown ||= run.costUnknown;
		agg.durationMs += run.durationMs;
		return;
	}
	agg.runs += 1;
	if (run.pass) agg.passes += 1;
	if (run.error) agg.errors += 1;
	if (run.errorKind) agg.errorKinds[run.errorKind] += 1;
	for (const name of run.failedChecks) agg.failing[name] = (agg.failing[name] ?? 0) + 1;
	agg.steps += run.steps;
	agg.promptTokens += run.promptTokens;
	agg.completionTokens += run.completionTokens;
	agg.costUsd += run.costUsd;
	agg.costUnknown ||= run.costUnknown;
	agg.durationMs += run.durationMs;
	addQuality(agg.quality, run.quality);
}

/** Conjuntos de cenários que a matriz compara lado a lado (04-avaliacao §1.1): o do dono e o genérico. */
export const SCENARIO_SETS = ["gold", "generic"] as const;
export type ScenarioSet = (typeof SCENARIO_SETS)[number];

/** Capacidade = pasta do conjunto (`gold/<capacidade>/` ou `generic/<capacidade>/`), que é a tag depois da do conjunto; fora deles, a 1ª tag. */
export function capabilityOf(tags: readonly string[]): string {
	const first = tags[0] as ScenarioSet | undefined;
	return ((first && SCENARIO_SETS.includes(first) ? tags[1] : first)) ?? "geral";
}

/** Conjunto do cenário pela tag (`gold` ou `generic`), ou `null` (sementes e cenários avulsos). */
export function setOf(tags: readonly string[] | undefined): ScenarioSet | null {
	return SCENARIO_SETS.find((set) => tags?.includes(set)) ?? null;
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
	/** Juízes da rubrica (vazio = sem juiz) e o teto de discordância. */
	judging: { models: string[]; maxGap: number } | null;
	skippedBudget: number;
	/** Execuções interrompidas em andamento quando o teto foi atingido (`stopped_budget`). */
	stoppedBudget: number;
	budgetStopped: boolean;
	costUnknown: boolean;
	scenarios: Array<{ id: string; capability: string; tags?: string[] }>;
	/** cenário → motor → modelo. */
	cells: Grid;
	/** capacidade → motor → modelo. */
	byCapability: Grid;
	/** motor → modelo (agregado de todos os cenários). */
	byModel: Record<string, Record<string, Agg>>;
	/**
	 * conjunto (`gold`/`generic`) → motor → modelo. Só existe quando os DOIS conjuntos estão na matriz: é o aceite da
	 * mudança de motor, que tem que manter ou melhorar os dois (04-avaliacao §1.1).
	 */
	bySet?: Partial<Record<ScenarioSet, Record<string, Record<string, Agg>>>>;
	byProvider: Record<string, { runs: number; costUsd: number; costUnknown: boolean; promptTokens: number; completionTokens: number }>;
	/** cenário → motor → leitura "modelo ou harness" (ver 04-avaliacao §3). */
	readings: Record<string, Record<string, { verdict: Verdict; reason: string }>>;
	engineDeltas: EngineDelta[];
};

/** Execuções sem erro de execução (nem corte de tempo do runtime, nem erro do provedor): as que dizem algo sobre o modelo. */
export const cleanRunsOf = (agg: Pick<Agg, "runs" | "errorKinds">): number => agg.runs - ERROR_KINDS.reduce((sum, kind) => sum + agg.errorKinds[kind], 0);

/** Acerto só nas execuções sem erro de execução (`null` se não sobrou nenhuma). `passes` não inclui erro, então vale o mesmo numerador. */
export const cleanPassRateOf = (agg: Pick<Agg, "runs" | "passes" | "errorKinds">): number | null => {
	const clean = cleanRunsOf(agg);
	return clean <= 0 ? null : agg.passes / clean;
};

export const passRateOf = (agg: Pick<Agg, "runs" | "passes">): number | null => (agg.runs === 0 ? null : agg.passes / agg.runs);

export function summarizeMatrix(
	runs: readonly MatrixRun[],
	options: { engines: string[]; models: string[]; scenarios: Array<{ id: string; capability: string; tags?: string[] }>; repeat: number; mode: "real" | "simulate"; capUsd?: number; judgeUsd?: number; judging?: { models: string[]; maxGap: number }; isStrong: (model: string) => boolean; createdAt?: string },
): MatrixSummary {
	const cells: Grid = {};
	const byCapability: Grid = {};
	const byModel: Record<string, Record<string, Agg>> = {};
	const byProvider: MatrixSummary["byProvider"] = {};
	const setByScenario = new Map(options.scenarios.map((scenario) => [scenario.id, setOf(scenario.tags)] as const));
	const sets = new Set(options.scenarios.map((scenario) => setOf(scenario.tags)));
	const compareSets = sets.has("gold") && sets.has("generic");
	const bySet: NonNullable<MatrixSummary["bySet"]> = {};
	for (const run of runs) {
		const set = setByScenario.get(run.scenarioId);
		if (compareSets && set) add((((bySet[set] ??= {})[run.engine] ??= {})[run.model] ??= emptyAgg()), run);
		add(slot(cells, run.scenarioId, run.engine, run.model), run);
		add(slot(byCapability, run.capability, run.engine, run.model), run);
		add(((byModel[run.engine] ??= {})[run.model] ??= emptyAgg()), run);
		if (run.status !== "skipped_budget") {
			const provider = (byProvider[run.provider] ??= { runs: 0, costUsd: 0, costUnknown: false, promptTokens: 0, completionTokens: 0 });
			if (run.status === "done") provider.runs += 1;
			provider.costUsd += run.costUsd;
			provider.costUnknown ||= run.costUnknown;
			provider.promptTokens += run.promptTokens;
			provider.completionTokens += run.completionTokens;
		}
	}
	const readings: MatrixSummary["readings"] = {};
	for (const scenario of options.scenarios) {
		for (const engine of options.engines) {
			// Timeout do runtime e erro do provedor não são falha do modelo: a leitura harness × modelo usa só as execuções
			// limpas, e o relatório diz quantas foram desconsideradas e por quê.
			const aggs = options.models.map((model) => cells[scenario.id]?.[engine]?.[model] ?? emptyAgg());
			const stats: ModelStat[] = options.models.map((model, index) => {
				const agg = aggs[index]!;
				return { model, runs: cleanRunsOf(agg), passes: agg.passes, errors: Math.max(0, agg.errors - ERROR_KINDS.reduce((sum, kind) => sum + agg.errorKinds[kind], 0)), failing: agg.failing, costUsd: agg.costUsd, costUnknown: agg.costUnknown };
			});
			const infra = ERROR_KINDS.map((kind) => ({ kind, count: aggs.reduce((sum, agg) => sum + agg.errorKinds[kind], 0) })).filter((item) => item.count > 0);
			const infraNote = infra.map((item) => `${item.count} ${ERROR_KIND_LABELS[item.kind]}`).join(", ");
			let reading = diagnose(stats, options.isStrong);
			if (infra.length > 0) {
				reading = stats.every((stat) => stat.runs === 0) ? { verdict: "erro de execução", reason: `todas as execuções acabaram em erro de execução (${infraNote}): não diz nada sobre o modelo` } : { ...reading, reason: `${reading.reason} (desconsiderado: ${infraNote})` };
			}
			// Lacuna conhecida do motor (tag `lacuna-<motor>`): continua sendo culpa do harness, mas o relatório diz que já se
			// sabia (o motor não oferece a ferramenta certa), para ninguém caçar defeito de modelo ou de cenário.
			const knownGap = (scenario.tags ?? []).includes(`lacuna-${engine}`) && reading.verdict === "harness/instruções";
			(readings[scenario.id] ??= {})[engine] = knownGap ? { verdict: reading.verdict, reason: `lacuna conhecida do motor ${engine}: ele não oferece a ferramenta certa (ver a descrição do cenário)` } : reading;
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
	const stoppedBudget = runs.filter((run) => run.status === "stopped_budget").length;
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
		judging: options.judging && options.judging.models.length > 0 ? options.judging : null,
		skippedBudget,
		stoppedBudget,
		budgetStopped: skippedBudget > 0 || stoppedBudget > 0,
		costUnknown: runs.some((run) => run.costUnknown),
		scenarios: options.scenarios,
		cells,
		byCapability,
		byModel,
		...(compareSets ? { bySet } : {}),
		byProvider,
		readings,
		engineDeltas,
	};
}
