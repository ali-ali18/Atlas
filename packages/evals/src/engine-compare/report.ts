import type { CompareResult } from "./run.js";
import type { EngineKind, RunMetrics } from "./metrics.js";

const pct = (value: number) => `${Math.round(value * 100)}%`;
const usd = (value: number) => `US$ ${value.toFixed(4)}`;

export type EngineTotals = { engine: EngineKind; tasks: number; completed: number; questions: number; modelCalls: number; costUsd: number; unconfirmed: number; documents: number; coverage: number };

export function totalsByEngine(runs: readonly RunMetrics[]): EngineTotals[] {
	return (["v1", "v2"] as EngineKind[]).map((engine) => {
		const own = runs.filter((run) => run.engine === engine);
		const sum = (pick: (run: RunMetrics) => number) => own.reduce((total, run) => total + pick(run), 0);
		return {
			engine,
			tasks: own.length,
			completed: own.filter((run) => run.completed).length,
			questions: sum((run) => run.questions),
			modelCalls: sum((run) => run.modelCalls),
			costUsd: sum((run) => run.costUsd),
			unconfirmed: sum((run) => run.unconfirmed),
			documents: own.filter((run) => run.documentGenerated).length,
			coverage: own.length === 0 ? 0 : sum((run) => run.coverage) / own.length,
		};
	});
}

const cell = (run: RunMetrics | undefined) =>
	run
		? `${run.completed ? "sim" : "não"} · ${run.stopReason}${run.stopDetail ? `/${run.stopDetail}` : ""} · ${pct(run.coverage)} · ${run.questions}? · ${run.modelCalls} cham. · ${usd(run.costUsd)}${run.unconfirmed ? ` · ${run.unconfirmed} n/c` : ""}${run.documentGenerated ? " · doc" : ""}`
		: "-";

/** Relatório em markdown (pt-BR): resumo por motor, uma linha por tarefa e as ressalvas de leitura. */
export function formatComparisonReport(result: CompareResult, meta: { generatedAt?: string } = {}): string {
	const totals = totalsByEngine(result.runs);
	const [v1, v2] = totals as [EngineTotals, EngineTotals];
	const lines: string[] = [];
	lines.push("# Motor atual (v1) × motor novo (v2): comparativo");
	lines.push("");
	lines.push(`Modo: **${result.mode === "mock" ? "roteiro (sem rede, determinístico)" : "ao vivo (modelo de verdade)"}**${meta.generatedAt ? ` · gerado em ${meta.generatedAt}` : ""}`);
	lines.push(`Custo estimado = tokens enviados e recebidos × US$ ${result.prices.promptUsdPerMTok}/Mtok de entrada e US$ ${result.prices.completionUsdPerMTok}/Mtok de saída.`);
	lines.push("");
	lines.push("## Resumo");
	lines.push("");
	lines.push("| Medida | Atual (v1) | Novo (v2) |");
	lines.push("|---|---|---|");
	lines.push(`| Tarefas concluídas (resposta normal, sem trava) | ${v1.completed}/${v1.tasks} | ${v2.completed}/${v2.tasks} |`);
	lines.push(`| Cobertura média do pedido (termos pedidos que aparecem na entrega) | ${pct(v1.coverage)} | ${pct(v2.coverage)} |`);
	lines.push(`| Perguntas ao usuário (total) | ${v1.questions} | ${v2.questions} |`);
	lines.push(`| Chamadas ao modelo (total) | ${v1.modelCalls} | ${v2.modelCalls} |`);
	lines.push(`| Custo estimado (total) | ${usd(v1.costUsd)} | ${usd(v2.costUsd)} |`);
	lines.push(`| Itens "não confirmados" listados | ${v1.unconfirmed} | ${v2.unconfirmed} |`);
	lines.push(`| Tarefas que geraram documento | ${v1.documents} | ${v2.documents} |`);
	lines.push("");
	lines.push("## Por tarefa");
	lines.push("");
	lines.push("Cada célula: concluiu? · motivo de término · cobertura · perguntas · chamadas ao modelo · custo · itens não confirmados (n/c) · documento.");
	lines.push("");
	lines.push("| Tarefa | Atual (v1) | Novo (v2) |");
	lines.push("|---|---|---|");
	for (const task of result.tasks) {
		const find = (engine: EngineKind) => result.runs.find((run) => run.taskId === task.id && run.engine === engine);
		lines.push(`| ${task.id} | ${cell(find("v1"))} | ${cell(find("v2"))} |`);
	}
	const errors = result.runs.filter((run) => run.error);
	if (errors.length > 0) {
		lines.push("");
		lines.push("## Erros de execução");
		lines.push("");
		for (const run of errors) lines.push(`- ${run.engine} · ${run.taskId}: ${run.error}`);
	}
	lines.push("");
	lines.push("## Como ler");
	lines.push("");
	if (result.mode === "mock") {
		lines.push("- Os dois motores recebem o **mesmo comportamento de pesquisa** de um modelo roteirizado (as mesmas buscas e leituras); o v2 acrescenta lista de tarefas, caderno e documento, que o prompt dele pede. O comparativo mede o que cada **motor** faz com esse comportamento (travas, perguntas, entrega, custo). Ele **não** mede qualidade de modelo: para isso use `--live`.");
		lines.push("- Sem ajudantes (`delegate` precisa do banco): o v2 aqui é o coordenador sozinho. O ganho de \"Sonnet coordena + Haiku nos ajudantes\" só aparece em produção.");
	} else {
		lines.push("- Modelo de verdade, com o mundo falso do `world.ts` (as buscas e leituras respondem com os mesmos dados fictícios). Uma rodada por tarefa e motor: resultado ruidoso, repita antes de concluir.");
	}
	lines.push("- \"Concluiu\" exige término normal (`answered`) e texto na entrega. Parar por orçamento (`budget_*`) ou por repetição (`loop_repeat`) não conta, mesmo quando o v2 entrega o que tem.");
	lines.push("- Cobertura = fração dos nomes/itens pedidos que aparecem no texto final ou no documento; é uma régua grossa, leia as entregas antes de decidir.");
	return `${lines.join("\n")}\n`;
}
