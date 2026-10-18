import type { RunMetrics } from "./metrics.js";

export type CellSummary = {
	taskId: string;
	model: string;
	runs: number;
	successes: number;
	/** Mediana dos itens certos / pedidos. */
	score: number;
	decisions: Spread;
	toolCalls: Spread;
	wallMs: Spread;
	modelMs: Spread;
	toolMs: Spread;
	promptTokens: Spread;
	costUsd: number;
	costKnown: boolean;
	slowClicks: number;
	emptyReads: number;
	nudges: number;
	screenshots: number;
	askedUser: number;
};

/** Mediana e pior caso (PLANO-VM: reportar os dois, a variância entre runs é grande). */
export type Spread = { median: number; worst: number };

export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const spread = (values: number[]): Spread => ({ median: Math.round(median(values)), worst: values.length ? Math.max(...values) : 0 });
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function summarize(runs: RunMetrics[]): CellSummary[] {
	const groups = new Map<string, RunMetrics[]>();
	for (const run of runs) {
		const key = `${run.taskId}\u0000${run.model}`;
		groups.set(key, [...(groups.get(key) ?? []), run]);
	}
	return [...groups.values()]
		.map((group) => {
			const first = group[0]!;
			return {
				taskId: first.taskId,
				model: first.model,
				runs: group.length,
				successes: group.filter((run) => run.success).length,
				score: median(group.map((run) => run.score)),
				decisions: spread(group.map((run) => run.decisions)),
				toolCalls: spread(group.map((run) => run.toolCalls)),
				wallMs: spread(group.map((run) => run.wallMs)),
				modelMs: spread(group.map((run) => run.modelMs)),
				toolMs: spread(group.map((run) => run.toolMs)),
				promptTokens: spread(group.map((run) => run.promptTokens)),
				costUsd: sum(group.map((run) => run.costUsd)),
				costKnown: group.every((run) => run.costKnown),
				slowClicks: sum(group.map((run) => run.slowClicks)),
				emptyReads: sum(group.map((run) => run.emptyReads)),
				nudges: sum(group.map((run) => run.nudges)),
				screenshots: sum(group.map((run) => run.screenshots)),
				askedUser: group.filter((run) => run.askedUser).length,
			};
		})
		.sort((a, b) => a.model.localeCompare(b.model) || taskOrder(a.taskId) - taskOrder(b.taskId));
}

const taskOrder = (id: string) => Number(id.replace(/\D/g, "")) || 0;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const usd = (value: number, known: boolean) => `${value.toFixed(4)}${known ? "" : "+"}`;
const pair = (value: Spread, format: (n: number) => string = String) => `${format(value.median)} / ${format(value.worst)}`;

/** Tabela markdown: uma linha por (modelo, tarefa). Colunas "med / pior" quando há repetições. */
export function renderMarkdown(runs: RunMetrics[], meta: { startedAt?: string; note?: string } = {}): string {
	const cells = summarize(runs);
	const lines = [
		`# Resultados do harness da VM${meta.startedAt ? ` (${meta.startedAt})` : ""}`,
		"",
		...(meta.note ? [meta.note, ""] : []),
		"| Modelo | Tarefa | Sucesso | Itens | Decisões (med/pior) | Tools (med/pior) | Parede (med/pior) | Modelo | Tools | Tokens prompt (med/pior) | Custo US$ | Cliques lentos | Leituras vazias | Dicas | Screenshots | Perguntou |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
		...cells.map((cell) =>
			[
				cell.model,
				cell.taskId,
				`${cell.successes}/${cell.runs}`,
				`${Math.round(cell.score * 100)}%`,
				pair(cell.decisions),
				pair(cell.toolCalls),
				pair(cell.wallMs, seconds),
				seconds(cell.modelMs.median),
				seconds(cell.toolMs.median),
				pair(cell.promptTokens),
				usd(cell.costUsd, cell.costKnown),
				cell.slowClicks,
				cell.emptyReads,
				cell.nudges,
				cell.screenshots,
				cell.askedUser,
			].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
		),
	];
	const failures = runs.filter((run) => !run.success);
	if (failures.length > 0) {
		lines.push("", "## Falhas", "");
		for (const run of failures) {
			lines.push(`- ${run.model} ${run.taskId} #${run.rep}: ${run.outcome}${run.error ? ` (${run.error})` : ""}; ${run.details.join("; ")}`);
		}
	}
	const navs = runs.filter((run) => run.navigate.count > 0);
	if (navs.length > 0) {
		const total = sum(navs.map((run) => run.navigate.count));
		const weighted = sum(navs.map((run) => run.navigate.avgMs * run.navigate.count));
		lines.push("", `Navigate: ${total} chamadas, média ${seconds(weighted / total)} (até o texto legível; ver telemetria nav para goto x espera).`);
	}
	return `${lines.join("\n")}\n`;
}

export function renderJson(runs: RunMetrics[], meta: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ meta, runs, summary: summarize(runs) }, null, 2)}\n`;
}
