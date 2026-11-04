import { BENCH_TASKS } from "./tasks.js";
import { toolsFor, type RunMetrics, type ToolMode } from "./run.js";

const usd = (value: number) => `US$ ${value.toFixed(4)}`;
const sum = (runs: readonly RunMetrics[], pick: (run: RunMetrics) => number) => runs.reduce((total, run) => total + pick(run), 0);

export const schemaChars = (mode: ToolMode) => toolsFor(mode).reduce((total, tool) => total + JSON.stringify(tool).length, 0);

/** Agregado por conjunto de tools (e modelo): completou, passos, tokens, "clicou e nada aconteceu", custo. */
export function summarize(runs: readonly RunMetrics[]) {
	return {
		runs: runs.length,
		completed: runs.filter((run) => run.completed).length,
		steps: sum(runs, (run) => run.steps),
		toolCalls: sum(runs, (run) => run.toolCalls),
		toolErrors: sum(runs, (run) => run.toolErrors),
		silentClicks: sum(runs, (run) => run.silentClicks),
		promptTokens: sum(runs, (run) => run.promptTokens),
		completionTokens: sum(runs, (run) => run.completionTokens),
		costUsd: sum(runs, (run) => run.costUsd),
	};
}

export function formatBenchReport(runs: readonly RunMetrics[], options: { title: string; note?: string }): string {
	const lines: string[] = [`# ${options.title}`, ""];
	if (options.note) lines.push(options.note, "");
	const keys = [...new Set(runs.map((run) => `${run.model}|${run.mode}`))];
	lines.push("## Resumo", "", "| modelo | tools | schema (car.) | completou | passos | chamadas | erros de tool | clicou e nada aconteceu | tokens entrada | tokens saída | custo |", "|---|---|---|---|---|---|---|---|---|---|---|");
	for (const key of keys) {
		const [model, mode] = key.split("|") as [string, ToolMode];
		const subset = runs.filter((run) => run.model === model && run.mode === mode);
		const s = summarize(subset);
		lines.push(`| ${model} | ${mode === "v3" ? "v3 (4 tools)" : "atuais (12 tools)"} | ${schemaChars(mode)} | ${s.completed}/${s.runs} | ${s.steps} | ${s.toolCalls} | ${s.toolErrors} | ${s.silentClicks} | ${s.promptTokens.toLocaleString("pt-BR")} | ${s.completionTokens.toLocaleString("pt-BR")} | ${usd(s.costUsd)} |`);
	}
	lines.push("", "## Por tarefa", "", "| tarefa | modelo | tools | resultado | passos | tokens entrada | nada aconteceu | detalhe |", "|---|---|---|---|---|---|---|---|");
	for (const task of BENCH_TASKS) {
		for (const run of runs.filter((item) => item.taskId === task.id)) {
			lines.push(`| ${task.id} | ${run.model} | ${run.mode} | ${run.completed ? "ok" : "FALHOU"} | ${run.steps} | ${run.promptTokens.toLocaleString("pt-BR")} | ${run.silentClicks} | ${run.error ? `erro: ${run.error}` : run.detail} |`);
		}
	}
	const errored = runs.filter((run) => run.toolErrorSamples.length > 0);
	if (errored.length) {
		lines.push("", "## Erros de tool", "", "| tarefa | modelo | tools | chamada → erro |", "|---|---|---|---|");
		for (const run of errored) {
			for (const sample of run.toolErrorSamples) lines.push(`| ${run.taskId} | ${run.model} | ${run.mode} | ${sample.replace(/\|/g, "\\|")} |`);
		}
	}
	return lines.join("\n");
}

/** Estimativa de custo de uma rodada real a partir dos tokens medidos no mock (margem: o modelo real erra e refaz). */
export const ESTIMATE_MARGIN = 1.5;
export function estimateRealCost(mockRuns: readonly RunMetrics[], price: { promptUsdPerMTok: number; completionUsdPerMTok: number }, input: { modes: readonly ToolMode[]; repeat: number; extraOutputPerStep?: number }): number {
	let total = 0;
	for (const mode of input.modes) {
		const subset = mockRuns.filter((run) => run.mode === mode);
		const prompt = sum(subset, (run) => run.promptTokens);
		const completion = sum(subset, (run) => run.completionTokens) + sum(subset, (run) => run.steps) * (input.extraOutputPerStep ?? 0);
		total += (prompt * price.promptUsdPerMTok + completion * price.completionUsdPerMTok) / 1_000_000;
	}
	return total * input.repeat * ESTIMATE_MARGIN;
}
