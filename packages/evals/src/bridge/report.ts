import { diagnose, type ModelStat, type Verdict } from "../verdict.js";
import { BRIDGE_CRITERIA, judgeCell, summarizeCell, type BridgeCell, type BridgeEngine, type FamilyVerdict } from "./metrics.js";
import type { BridgeSuiteResult } from "./run.js";

/**
 * Relatório da avaliação da ponte: matriz tarefa × modelo × motor com o veredito `modelo | harness | instável`
 * (reaproveita `verdict.ts`), os critérios do desenho 14.2 por modelo e a decisão do marco M1. Funções puras.
 */

export type BridgeDecisionKind = "ponte-aprovada" | "familias-usam-carrega-e-anexa" | "padrao-vira-carrega-e-anexa" | "sem-decisao";

export type BridgeDecision = { kind: BridgeDecisionKind; text: string; failingCheap: string[]; failingStrong: string[] };

export type BridgeCellReport = { model: string; engine: BridgeEngine; cell: BridgeCell; verdict: FamilyVerdict };

export type BridgeTaskMatrixRow = {
	taskId: string;
	/** `${model}|${engine}` → acertos/execuções. */
	cells: Record<string, { runs: number; found: number; errors: number }>;
	/** Veredito `modelo | harness | instável` por motor, entre os modelos. */
	verdicts: Partial<Record<BridgeEngine, { verdict: Verdict; reason: string }>>;
	/** Motivos de falha mais comuns (por motor). */
	failures: Partial<Record<BridgeEngine, Record<string, number>>>;
};

export type BridgeReport = {
	v: 1;
	generatedAt: string;
	mode: "mock" | "real";
	repeat: number;
	models: string[];
	engines: BridgeEngine[];
	criteria: typeof BRIDGE_CRITERIA;
	spentUsd: number;
	skippedByBudget: number;
	cells: BridgeCellReport[];
	matrix: BridgeTaskMatrixRow[];
	decision: BridgeDecision;
};

/** Agrupa o motivo da falha pelo trecho antes de ":" (o resto tem nomes de tool e varia). */
const failureKind = (failure: string) => failure.split(":")[0]!.trim();

export function decide(cells: readonly BridgeCellReport[], isStrong: (model: string) => boolean): BridgeDecision {
	const v3 = cells.filter((entry) => entry.engine === "v3");
	if (v3.length === 0 || v3.every((entry) => entry.verdict.status === "sem dados")) return { kind: "sem-decisao", text: "Sem dados do v3 para decidir.", failingCheap: [], failingStrong: [] };
	const failing = v3.filter((entry) => entry.verdict.status === "reprova");
	const failingCheap = failing.filter((entry) => !isStrong(entry.model)).map((entry) => entry.model);
	const failingStrong = failing.filter((entry) => isStrong(entry.model)).map((entry) => entry.model);
	if (failingCheap.length >= 2) {
		return { kind: "padrao-vira-carrega-e-anexa", text: `${failingCheap.length} famílias baratas reprovam a ponte (${failingCheap.join(", ")}): o padrão vira "carrega e anexa", com o catálogo congelado por conversa para conter a quebra de cache, antes de construir o resto.`, failingCheap, failingStrong };
	}
	if (failingCheap.length === 1) {
		return { kind: "familias-usam-carrega-e-anexa", text: `A família ${failingCheap[0]} reprova a ponte e usa "carrega e anexa" (D3); a ponte segue como padrão para as demais.`, failingCheap, failingStrong };
	}
	const warning = failingStrong.length > 0 ? ` Atenção: o modelo de controle (${failingStrong.join(", ")}) reprovou; vale ler as trajetórias antes de confiar no resultado.` : "";
	return { kind: "ponte-aprovada", text: `Nenhuma família barata reprova: a ponte segue como padrão.${warning}`, failingCheap, failingStrong };
}

export function buildBridgeReport(result: BridgeSuiteResult, options: { isStrong: (model: string) => boolean; generatedAt?: string }): BridgeReport {
	const cells: BridgeCellReport[] = [];
	for (const model of result.models) {
		const byEngine = new Map<BridgeEngine, BridgeCell>();
		for (const engine of result.engines) byEngine.set(engine, summarizeCell(result.runs.filter((run) => run.model === model && run.engine === engine)));
		for (const engine of result.engines) {
			const cell = byEngine.get(engine)!;
			cells.push({ model, engine, cell, verdict: judgeCell(cell, engine === "v3" ? byEngine.get("v2") : undefined) });
		}
	}
	const matrix: BridgeTaskMatrixRow[] = result.tasks.map((task) => {
		const row: BridgeTaskMatrixRow = { taskId: task.id, cells: {}, verdicts: {}, failures: {} };
		for (const engine of result.engines) {
			const stats: ModelStat[] = [];
			for (const model of result.models) {
				const runs = result.runs.filter((run) => run.taskId === task.id && run.model === model && run.engine === engine);
				row.cells[`${model}|${engine}`] = { runs: runs.length, found: runs.filter((run) => run.found).length, errors: runs.filter((run) => run.error).length };
				const failing: Record<string, number> = {};
				for (const run of runs) if (run.failure) failing[failureKind(run.failure)] = (failing[failureKind(run.failure)] ?? 0) + 1;
				stats.push({ model, runs: runs.length, passes: runs.filter((run) => run.found).length, errors: runs.filter((run) => run.error).length, failing, costUsd: runs.reduce((sum, run) => sum + run.costUsd, 0), costUnknown: false });
				for (const [kind, count] of Object.entries(failing)) (row.failures[engine] ??= {})[kind] = ((row.failures[engine] ??= {})[kind] ?? 0) + count;
			}
			row.verdicts[engine] = diagnose(stats, options.isStrong);
		}
		return row;
	});
	return {
		v: 1,
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		mode: result.mode,
		repeat: result.repeat,
		models: result.models,
		engines: result.engines,
		criteria: BRIDGE_CRITERIA,
		spentUsd: result.spentUsd,
		skippedByBudget: result.skippedByBudget,
		cells,
		matrix,
		decision: decide(cells, options.isStrong),
	};
}

const pct = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`);
const num = (value: number | null) => (value === null ? "-" : value.toFixed(2));
const usd = (value: number) => `US$ ${value.toFixed(4)}`;
const engineLabel = (engine: BridgeEngine) => (engine === "v3" ? "ponte (v3)" : "carrega e anexa (v2)");

export function formatBridgeReport(report: BridgeReport): string {
	const lines: string[] = [];
	lines.push("# Avaliação da ponte `tool_search`/`tool_call` (harness v3, marco M1)");
	lines.push("");
	lines.push(`Modo: **${report.mode === "mock" ? "roteiro (mock, sem rede): prova a mecânica, NÃO a qualidade dos modelos" : "modelo de verdade com fixtures"}** · ${report.models.length} modelo(s) × ${report.engines.map(engineLabel).join(" e ")} × ${report.repeat} repetição(ões) · gerado em ${report.generatedAt}`);
	lines.push(`Gasto: ${usd(report.spentUsd)}${report.skippedByBudget > 0 ? ` · ${report.skippedByBudget} execução(ões) pulada(s) pelo teto de gasto` : ""}`);
	lines.push("");
	lines.push("## Critérios (por família de modelo, no v3)");
	lines.push("");
	lines.push(`Tool certa em ≥ ${pct(report.criteria.accuracy)} · no máximo ${report.criteria.extraSteps} passo extra em média · JSON válido de primeira em ≥ ${pct(report.criteria.jsonFirstTry)} · nome inventado ≤ ${pct(report.criteria.invented)} · não pior que "carrega e anexa" em acerto por mais de ${report.criteria.maxLossVsV2 * 100} pontos.`);
	lines.push("");
	lines.push("## Decisão");
	lines.push("");
	lines.push(`**${report.decision.kind}**: ${report.decision.text}`);
	if (report.mode === "mock") lines.push("\nEste relatório é do modo mock: a decisão acima só mostra que a mecânica funciona. A decisão real vem da rodada com modelos de verdade.");
	lines.push("");
	lines.push("## Resumo por modelo e motor");
	lines.push("");
	lines.push("| Modelo | Motor | Acerto | Passos extras | JSON de 1ª | Nome inventado | Cache | Tokens de entrada | Custo | Veredito |");
	lines.push("|---|---|---|---|---|---|---|---|---|---|");
	for (const entry of report.cells) {
		const { cell, verdict } = entry;
		const label = verdict.status === "passa" ? "passa" : verdict.status === "sem dados" ? "sem dados" : `reprova: ${verdict.failures.join("; ")}`;
		lines.push(`| ${entry.model} | ${engineLabel(entry.engine)} | ${pct(cell.accuracy)} (${cell.found}/${cell.runs}) | ${num(cell.extraStepsMean)} | ${pct(cell.jsonFirstTryRate)} | ${pct(cell.inventedRate)} (${cell.inventedCalls}/${cell.actionCalls}) | ${pct(cell.cacheRate)} | ${cell.promptTokens.toLocaleString("pt-BR")} | ${usd(cell.costUsd)} | ${label} |`);
	}
	lines.push("");
	lines.push("## Matriz tarefa × modelo × motor");
	lines.push("");
	lines.push("Cada célula: acertos/execuções. Veredito por tarefa e motor entre os modelos: `ok`, `modelo` (os fortes passam, os baratos não), `harness/instruções` (ninguém passa), `instável` (varia entre repetições).");
	lines.push("");
	const columns = report.models.flatMap((model) => report.engines.map((engine) => ({ model, engine })));
	lines.push(`| Tarefa | ${columns.map((column) => `${column.model} · ${column.engine}`).join(" | ")} | ${report.engines.map((engine) => `veredito ${engine}`).join(" | ")} |`);
	lines.push(`|---|${columns.map(() => "---").join("|")}|${report.engines.map(() => "---").join("|")}|`);
	for (const row of report.matrix) {
		const cells = columns.map((column) => {
			const item = row.cells[`${column.model}|${column.engine}`];
			return item && item.runs > 0 ? `${item.found}/${item.runs}${item.errors > 0 ? ` erro(${item.errors})` : ""}` : "-";
		});
		lines.push(`| ${row.taskId} | ${cells.join(" | ")} | ${report.engines.map((engine) => row.verdicts[engine]?.verdict ?? "-").join(" | ")} |`);
	}
	const withFailures = report.matrix.filter((row) => Object.keys(row.failures).length > 0);
	if (withFailures.length > 0) {
		lines.push("");
		lines.push("## Falhas por tarefa");
		lines.push("");
		for (const row of withFailures) for (const engine of report.engines) {
			const failures = row.failures[engine];
			if (failures) lines.push(`- ${row.taskId} · ${engine}: ${Object.entries(failures).map(([kind, count]) => `${kind} (${count})`).join(", ")} — ${row.verdicts[engine]?.reason ?? ""}`);
		}
	}
	lines.push("");
	lines.push("## Como ler");
	lines.push("");
	lines.push("- \"Acerto\" = fez as tools certas, na ordem, com os argumentos certos e resultado ok, e nenhuma tool proibida (a errada parecida). Em \"tool inexistente\", acerto = nenhuma tool de ação e uma resposta ao usuário.");
	lines.push("- \"Passos extras\" = chamadas de modelo além do mínimo da tarefa até a última tool certa (uma busca de `tool_search` ou `mcp_tool_search` conta como um passo).");
	lines.push("- \"JSON de 1ª\" = o primeiro pedido de cada tool certa veio com JSON de objeto e passou no schema (obrigatórios e tipos); a ponte conta o invólucro `tool_call` também.");
	lines.push("- \"Nome inventado\" = pedidos de tool de ação com um nome que não existe neste mundo (fração dos pedidos de ação).");
	lines.push("- Com poucas repetições uma única falha pode reprovar o critério de 95%: leia as trajetórias (`runs.jsonl`) antes de decidir.");
	return `${lines.join("\n")}\n`;
}
