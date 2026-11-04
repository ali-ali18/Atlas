import { startFixtureServer } from "./fixtures.js";
import { assertKeysFor, claudePriceFor, createRealModel, isClaudeDirect, type ClaudePrice } from "./providers.js";
import { estimateRealCost, formatBenchReport } from "./report.js";
import { realDriver, runBenchTask, TOOL_MODES, type RunMetrics, type ToolMode } from "./run.js";
import { BENCH_TASKS } from "./tasks.js";
import { findChromium, startBenchVm } from "./vm-harness.js";

export { BENCH_TASKS, taskById, refOf } from "./tasks.js";
export { findChromium } from "./vm-harness.js";
export { estimateRealCost, formatBenchReport, schemaChars, summarize } from "./report.js";
export { assertKeysFor, claudePriceFor, isClaudeDirect } from "./providers.js";
export { TOOL_MODES, type RunMetrics, type ToolMode } from "./run.js";

export type BenchOptions = {
	/** Modelos reais (`claude-*` direto na Anthropic ou id do OpenRouter); vazio = modo mock (roteiro, grátis). */
	models: readonly string[];
	modes?: readonly ToolMode[];
	only?: readonly string[];
	repeat?: number;
	maxCostUsd?: number;
	timeoutMs?: number;
	prices?: readonly ClaudePrice[];
	env?: Record<string, string | undefined>;
	onProgress?: (run: RunMetrics) => void;
};

/** Roda o bench: sobe as fixtures e a VM de bancada uma vez e executa tarefa × tools × modelo × repetição. */
export async function runBrowserBench(options: BenchOptions): Promise<{ runs: RunMetrics[]; stoppedByCost: boolean }> {
	const real = options.models.length > 0;
	const env = options.env ?? process.env;
	if (real) assertKeysFor(options.models, env, options.prices);
	if (!findChromium()) throw new Error("bench: nenhum Chromium encontrado (ATLAS_TEST_CHROMIUM ou PLAYWRIGHT_BROWSERS_PATH).");
	const tasks = BENCH_TASKS.filter((task) => !options.only?.length || options.only.includes(task.id));
	const modes = options.modes ?? TOOL_MODES;
	const model = real ? createRealModel(env, { ...(options.prices ? { prices: options.prices } : {}) }) : undefined;
	const fixtures = await startFixtureServer();
	const runs: RunMetrics[] = [];
	let spent = 0;
	let stoppedByCost = false;
	try {
		for (const modelId of real ? options.models : ["mock/scripted"]) {
			for (let repeat = 0; repeat < (options.repeat ?? 1); repeat += 1) {
				for (const task of tasks) {
					for (const mode of modes) {
						if (options.maxCostUsd !== undefined && spent >= options.maxCostUsd) {
							stoppedByCost = true;
							continue;
						}
						// Uma VM de bancada nova por execução: nenhum estado de aba, cookie ou ref vaza de uma tarefa para a outra
						// (a 2ª visita à mesma página com modal numerava os refs do frame principal como f1 e travava o clique).
						const vm = await startBenchVm();
						const run = await runBenchTask({ task, mode, model: modelId, vm, fixtures, ...(real ? { driver: realDriver(modelId, model!.streamChat) } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
						await vm.close();
						spent += run.costUsd;
						runs.push(run);
						options.onProgress?.(run);
					}
				}
			}
		}
	} finally {
		await fixtures.close();
	}
	return { runs, stoppedByCost };
}

/** Linhas de estimativa (pt-BR) a partir de uma rodada mock: Haiku e Sonnet, `repeat` repetições nos dois conjuntos. */
export function formatEstimate(mockRuns: readonly RunMetrics[], repeat = 1): string {
	const lines = ["## Estimativa de custo da rodada real", "", `Tokens medidos na rodada mock (8 tarefas, um passo do roteiro por chamada); margem de 50% para passos extras do modelo real e 150 tokens de saída por passo. Sem desconto de cache (conservador). Repetições: ${repeat}.`, "", "| modelo | só v3 | só atuais | v3 + atuais |", "|---|---|---|---|"];
	for (const id of ["claude-haiku-5-5", "claude-sonnet-5-5"]) {
		const price = claudePriceFor(id);
		const cost = (modes: ToolMode[]) => `US$ ${estimateRealCost(mockRuns, price, { modes, repeat, extraOutputPerStep: 150 }).toFixed(2)}`;
		lines.push(`| ${id} (US$ ${price.promptUsdPerMTok}/${price.completionUsdPerMTok} por Mtok) | ${cost(["v3"])} | ${cost(["legacy"])} | ${cost(["v3", "legacy"])} |`);
	}
	return lines.join("\n");
}

export { formatBenchReport as formatReport };
