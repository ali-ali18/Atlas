import { LONG_WORK_MAX_MINUTES, LONG_WORK_MAX_USD, LONG_WORK_MIN_MINUTES, LONG_WORK_MIN_USD, readEnginePolicy, resolveRunProfile } from "@workspace/shared";
import type { EngineV2Options } from "@workspace/agent-runtime";
import { runScenario } from "../run-scenario.js";
import type { StreamChat } from "../mock-model.js";
import { createScriptedModel } from "./scripted-model.js";
import { DEFAULT_PRICES, measureRun, type EngineKind, type Prices, type RunMetrics } from "./metrics.js";
import { engineTasks, type EngineTask } from "./tasks.js";

export type CompareOptions = {
	prices?: Prices;
	/** Orçamento do trabalho longo no v2 (padrão do produto: US$ 0,50 e 20 min). */
	longWorkBudgetUsd?: number;
	longWorkMinutes?: number;
	/** Só estas tarefas (ids). */
	only?: readonly string[];
	/** Modo ao vivo: o modelo de verdade responde (`streamChat`); sem isto vale o roteiro. */
	live?: { model: string; apiKey: string; streamChat: StreamChat; helperModel?: string };
	timeoutMs?: number;
};

export type CompareResult = { tasks: EngineTask[]; runs: RunMetrics[]; prices: Prices; mode: "mock" | "live" };

/** O comparativo não usa `delegate` (precisa do banco): determinístico no mock, e no ao vivo mede o coordenador sozinho. */
const withoutDelegate = (name: string) => name !== "delegate" && name !== "delegate_task";

/** Preço de reserva do v2 igual ao do relatório, para orçamento e custo medido falarem a mesma língua. */
async function withFallbackPrices<T>(prices: Prices, fn: () => Promise<T>): Promise<T> {
	const before = { prompt: process.env.ATLAS_V2_FALLBACK_PROMPT_USD_PER_MTOK, completion: process.env.ATLAS_V2_FALLBACK_COMPLETION_USD_PER_MTOK };
	process.env.ATLAS_V2_FALLBACK_PROMPT_USD_PER_MTOK = String(prices.promptUsdPerMTok);
	process.env.ATLAS_V2_FALLBACK_COMPLETION_USD_PER_MTOK = String(prices.completionUsdPerMTok);
	try {
		return await fn();
	} finally {
		if (before.prompt === undefined) delete process.env.ATLAS_V2_FALLBACK_PROMPT_USD_PER_MTOK;
		else process.env.ATLAS_V2_FALLBACK_PROMPT_USD_PER_MTOK = before.prompt;
		if (before.completion === undefined) delete process.env.ATLAS_V2_FALLBACK_COMPLETION_USD_PER_MTOK;
		else process.env.ATLAS_V2_FALLBACK_COMPLETION_USD_PER_MTOK = before.completion;
	}
}

/** Orçamento fora da faixa do produto falha alto (zero ou negativo nunca vira o padrão em silêncio). */
export function assertBudgetInRange(name: string, value: number | undefined, min: number, max: number): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} deve ficar entre ${min} e ${max} (recebido: ${value}).`);
}

export async function runEngineComparison(options: CompareOptions = {}): Promise<CompareResult> {
	assertBudgetInRange("--budget-usd", options.longWorkBudgetUsd, LONG_WORK_MIN_USD, LONG_WORK_MAX_USD);
	assertBudgetInRange("--minutes", options.longWorkMinutes, LONG_WORK_MIN_MINUTES, LONG_WORK_MAX_MINUTES);
	const prices = options.prices ?? DEFAULT_PRICES;
	const tasks = engineTasks().filter((task) => !options.only || options.only.length === 0 || options.only.includes(task.id));
	const policy = readEnginePolicy({ engine: "v2", ...(options.longWorkBudgetUsd !== undefined ? { longWorkBudgetUsd: options.longWorkBudgetUsd } : {}), ...(options.longWorkMinutes !== undefined ? { longWorkMinutes: options.longWorkMinutes } : {}) });
	const runs: RunMetrics[] = [];
	await withFallbackPrices(prices, async () => {
		for (const task of tasks) {
			for (const engine of ["v1", "v2"] as EngineKind[]) {
				const v2Options: EngineV2Options = {
					profile: resolveRunProfile({ policy, text: task.user }),
					longWorkBudgetUsd: policy.longWorkBudgetUsd,
					longWorkMinutes: policy.longWorkMinutes,
					...(options.live?.helperModel ? { helpers: { model: options.live.helperModel } } : {}),
				};
				const trajectory = await runScenario(task.scenario, {
					model: options.live?.model ?? "mock/scripted",
					apiKey: options.live?.apiKey ?? "",
					streamChat: options.live ? options.live.streamChat : createScriptedModel(task.turns[engine]),
					variant: engine,
					timeoutMs: options.timeoutMs ?? 120_000,
					runtimeOverrides: { maxSteps: 100, humanTurn: true, toolFilter: withoutDelegate },
					...(engine === "v2" ? { engineV2: v2Options } : {}),
				});
				runs.push(measureRun({ engine, taskId: task.id, trajectory, mustMention: task.mustMention, prices }));
			}
		}
	});
	return { tasks, runs, prices, mode: options.live ? "live" : "mock" };
}
