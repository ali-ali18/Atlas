import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "@workspace/shared";
import { passed, runChecks, type Judge } from "./checks.js";
import { createMockModel, MOCK_MODEL, type StreamChat } from "./mock-model.js";
import { formatReport, summarize, type Summary } from "./report.js";
import { runScenario } from "./run-scenario.js";
import type { Scenario } from "./scenario.js";
import type { RunRecord } from "./trajectory.js";
import { applyVariantEnv, type HarnessVariant } from "./variants.js";

/**
 * Orquestra cenário × modelo × repetição × variante com limite de concorrência, grava cada trajetória em JSONL
 * (`runs.jsonl`), o resumo (`summary.json`) e a matriz (`matrix.txt`). A chave nunca é gravada: cada linha passa
 * por `redactSecrets` com a chave antes de ir ao disco.
 */

export type RunnerOptions = {
	scenarios: Scenario[];
	/** Ignorado no modo mock (usa o modelo roteirizado). */
	models: string[];
	mode: "real" | "mock";
	/** Fábrica do modelo real (OpenRouter); injetável em teste. */
	realStreamChat?: StreamChat;
	apiKey?: string;
	repeat?: number;
	concurrency?: number;
	timeoutMs?: number;
	variants?: Array<[string, HarnessVariant]>;
	judge?: Judge;
	/** Teto de gasto (US$): passado o teto, execuções que ainda não começaram são puladas. */
	maxCostUsd?: number;
	isStrong: (model: string) => boolean;
	outDir?: string;
	onProgress?: (record: RunRecord, done: number, total: number) => void;
};

export type RunnerResult = {
	records: RunRecord[];
	summary: Summary;
	report: string;
	/** Cenários sem roteiro (modo mock) — não rodam. */
	skipped: string[];
	/** Execuções não iniciadas por causa do teto de gasto. */
	skippedByBudget: number;
};

type Job = { scenario: Scenario; model: string; repeat: number };

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const item = items[next]!;
			next += 1;
			await worker(item);
		}
	});
	await Promise.all(lanes);
}

export async function runEvaluation(options: RunnerOptions): Promise<RunnerResult> {
	const mock = options.mode === "mock";
	const scenarios = mock ? options.scenarios.filter((scenario) => scenario.mock) : options.scenarios;
	const skipped = mock ? options.scenarios.filter((scenario) => !scenario.mock).map((scenario) => scenario.id) : [];
	const models = mock ? [MOCK_MODEL] : options.models;
	if (!mock && (!options.realStreamChat || !options.apiKey)) throw new Error("modo real precisa de realStreamChat e apiKey");
	if (models.length === 0) throw new Error("nenhum modelo");
	const variants = options.variants ?? [["base", { description: "padrão" }]];
	const repeat = Math.max(1, options.repeat ?? 1);
	const secrets = options.apiKey ? [options.apiKey] : [];
	const runsFile = options.outDir ? join(options.outDir, "runs.jsonl") : undefined;
	if (options.outDir) await mkdir(options.outDir, { recursive: true });

	const records: RunRecord[] = [];
	let spent = 0;
	let skippedByBudget = 0;
	const jobs: Job[] = scenarios.flatMap((scenario) => models.flatMap((model) => Array.from({ length: repeat }, (_, index) => ({ scenario, model, repeat: index }))));
	const total = jobs.length * variants.length;
	// Variantes em sequência: o `env` de uma não pode vazar para a outra.
	for (const [variantName, variant] of variants) {
		const restore = applyVariantEnv(variant);
		try {
			await pool(jobs, options.concurrency ?? 3, async (job) => {
				if (options.maxCostUsd !== undefined && spent >= options.maxCostUsd) {
					skippedByBudget += 1;
					return;
				}
				const trajectory = await runScenario(job.scenario, {
					model: job.model,
					apiKey: mock ? "mock" : options.apiKey!,
					streamChat: mock ? createMockModel(job.scenario) : options.realStreamChat!,
					variant: variantName,
					...(variant.params ? { runtimeOverrides: variant.params } : {}),
					repeat: job.repeat,
					...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
				});
				const checks = await runChecks(job.scenario, trajectory, options.judge ? { judge: options.judge } : {});
				const record: RunRecord = { scenarioId: job.scenario.id, model: job.model, variant: variantName, repeat: job.repeat, pass: passed(checks), checks, trajectory };
				const done = records.push(record);
				spent += trajectory.costUsd;
				if (runsFile) await appendFile(runsFile, `${redactSecrets(JSON.stringify(record), secrets)}\n`);
				options.onProgress?.(record, done, total);
			});
		} finally {
			restore();
		}
	}

	const summary = summarize(records, { isStrong: options.isStrong });
	// Ordem estável na matriz (a da bateria), não a de término.
	summary.scenarios = scenarios.map((scenario) => scenario.id).filter((id) => summary.scenarios.includes(id));
	summary.models = models.filter((model) => summary.models.includes(model));
	const report = `${formatReport(summary)}${skippedByBudget > 0 ? `\n${skippedByBudget} execução(ões) pulada(s): teto de US$ ${options.maxCostUsd} atingido` : ""}`;
	if (options.outDir) {
		await writeFile(join(options.outDir, "summary.json"), `${redactSecrets(JSON.stringify(summary, null, 2), secrets)}\n`);
		await writeFile(join(options.outDir, "matrix.txt"), `${report}\n`);
	}
	return { records, summary, report, skipped, skippedByBudget };
}
