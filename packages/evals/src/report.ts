import type { RunRecord } from "./trajectory.js";
import { diagnose, passRateDelta, type CellStat, type ModelStat, type Verdict } from "./verdict.js";

/** Agregação dos runs e a matriz em texto (funções puras). */

export type Summary = {
	v: 1;
	createdAt: string;
	models: string[];
	scenarios: string[];
	variants: string[];
	/** variante → cenário → modelo → estatística. */
	cells: Record<string, Record<string, Record<string, CellStat>>>;
	verdicts: Record<string, Record<string, { verdict: Verdict; reason: string }>>;
	costUsd: number;
	costUnknown: boolean;
	/** Tools chamadas sem fixture, por cenário (lacuna do cenário, não do modelo). */
	unmocked: Record<string, string[]>;
};

const emptyCell = (): CellStat => ({ runs: 0, passes: 0, errors: 0, failing: {}, costUsd: 0, costUnknown: false });

export function summarize(records: RunRecord[], options: { isStrong: (model: string) => boolean; createdAt?: string }): Summary {
	const models = [...new Set(records.map((record) => record.model))];
	const scenarios = [...new Set(records.map((record) => record.scenarioId))];
	const variants = [...new Set(records.map((record) => record.variant))];
	const cells: Summary["cells"] = {};
	const unmocked: Summary["unmocked"] = {};
	for (const record of records) {
		const cell = (((cells[record.variant] ??= {})[record.scenarioId] ??= {})[record.model] ??= emptyCell());
		cell.runs += 1;
		if (record.pass) cell.passes += 1;
		if (record.trajectory.error) cell.errors += 1;
		for (const item of record.checks) if (!item.pass && !item.skipped) cell.failing[item.name] = (cell.failing[item.name] ?? 0) + 1;
		cell.costUsd += record.trajectory.costUsd;
		cell.costUnknown ||= record.trajectory.costUnknown;
		if (record.trajectory.unmocked.length > 0) unmocked[record.scenarioId] = [...new Set([...(unmocked[record.scenarioId] ?? []), ...record.trajectory.unmocked])];
	}
	const verdicts: Summary["verdicts"] = {};
	for (const variant of variants) {
		for (const scenario of scenarios) {
			const stats: ModelStat[] = models.map((model) => ({ model, ...(cells[variant]?.[scenario]?.[model] ?? emptyCell()) }));
			(verdicts[variant] ??= {})[scenario] = diagnose(stats, options.isStrong);
		}
	}
	return {
		v: 1,
		createdAt: options.createdAt ?? new Date().toISOString(),
		models,
		scenarios,
		variants,
		cells,
		verdicts,
		costUsd: records.reduce((sum, record) => sum + record.trajectory.costUsd, 0),
		costUnknown: records.some((record) => record.trajectory.costUnknown),
		unmocked,
	};
}

function table(rows: string[][]): string {
	const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
	return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ").trimEnd()).join("\n");
}

/** Célula: "2/3 no_question(1)" — acertos/execuções e as verificações que falharam (com quantas vezes). */
export function formatCell(cell: CellStat | undefined, maxChecks = 2): string {
	if (!cell || cell.runs === 0) return "-";
	const failing = Object.entries(cell.failing).sort((a, b) => b[1] - a[1]);
	const head = `${cell.passes}/${cell.runs}${cell.passes === cell.runs ? " ok" : ""}`;
	if (failing.length === 0) return cell.errors > 0 ? `${head} erro(${cell.errors})` : head;
	const shown = failing.slice(0, maxChecks).map(([name, count]) => `${name}(${count})`).join(" ");
	return `${head} ${shown}${failing.length > maxChecks ? " +" + (failing.length - maxChecks) : ""}`;
}

export function formatMatrix(summary: Summary, variant: string): string {
	const header = ["cenário", ...summary.models, "veredito"];
	const rows = summary.scenarios.map((scenario) => [
		scenario,
		...summary.models.map((model) => formatCell(summary.cells[variant]?.[scenario]?.[model])),
		summary.verdicts[variant]?.[scenario]?.verdict ?? "-",
	]);
	return table([header, ...rows]);
}

export function formatReasons(summary: Summary, variant: string): string {
	return summary.scenarios
		.map((scenario) => {
			const verdict = summary.verdicts[variant]?.[scenario];
			return verdict && verdict.verdict !== "ok" ? `- ${scenario}: ${verdict.verdict} — ${verdict.reason}` : "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Delta de acerto (pontos percentuais) de `variant` sobre `base`, por cenário e modelo. */
export function formatDelta(baseSummary: Summary, baseVariant: string, variantSummary: Summary, variant: string): string {
	const models = [...new Set([...baseSummary.models, ...variantSummary.models])];
	const scenarios = [...new Set([...baseSummary.scenarios, ...variantSummary.scenarios])];
	const header = ["cenário", ...models.map((model) => `${model} (Δ pp)`)];
	const rows = scenarios.map((scenario) => [
		scenario,
		...models.map((model) => {
			const before = baseSummary.cells[baseVariant]?.[scenario]?.[model];
			const after = variantSummary.cells[variant]?.[scenario]?.[model];
			const delta = passRateDelta(before, after);
			return delta === null ? "-" : `${delta > 0 ? "+" : ""}${delta} (${before!.passes}/${before!.runs} → ${after!.passes}/${after!.runs})`;
		}),
	]);
	return table([header, ...rows]);
}

export function formatCost(summary: Pick<Summary, "costUsd" | "costUnknown">): string {
	return `custo: US$ ${summary.costUsd.toFixed(4)}${summary.costUnknown ? " (parcial: o provedor não informou o custo de alguma chamada)" : ""}`;
}

/** Relatório completo em texto (vai para o terminal e para `matrix.txt`). */
export function formatReport(summary: Summary): string {
	const parts: string[] = [];
	for (const variant of summary.variants) {
		parts.push(`== harness: ${variant} ==`, formatMatrix(summary, variant));
		const reasons = formatReasons(summary, variant);
		if (reasons) parts.push("", reasons);
		parts.push("");
	}
	const [base, ...others] = summary.variants;
	for (const other of others) parts.push(`== delta ${other} vs ${base} ==`, formatDelta(summary, base!, summary, other), "");
	const gaps = Object.entries(summary.unmocked);
	if (gaps.length > 0) parts.push("tools sem fixture (respondidas como indisponíveis):", ...gaps.map(([scenario, tools]) => `- ${scenario}: ${tools.join(", ")}`), "");
	parts.push(formatCost(summary));
	return parts.join("\n");
}
