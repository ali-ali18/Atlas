import { DIMENSIONS, DIMENSION_LABELS, dimensionMean, disputedRate, meanQuality, type QualityAgg } from "../quality.js";
import { ERROR_KINDS, ERROR_KIND_LABELS } from "../error-kind.js";
import { cleanPassRateOf, cleanRunsOf, passRateOf, type Agg, type MatrixSummary } from "./aggregate.js";

/** Relatório Markdown do matrix (determinístico: só formata o resumo). */

const usd = (value: number, unknown = false): string => `US$ ${value.toFixed(4)}${unknown ? "*" : ""}`;
const pct = (rate: number | null): string => (rate === null ? "-" : `${Math.round(rate * 100)}%`);
const ratio = (agg: Agg | undefined): string => {
	if (!agg) return "-";
	const extra = [agg.skipped > 0 ? `pulado (${agg.skipped})` : "", agg.stopped > 0 ? `interrompido (${agg.stopped})` : ""].filter(Boolean).join(", ");
	if (agg.runs === 0) return extra || "-";
	return extra ? `${agg.passes}/${agg.runs} + ${extra}` : `${agg.passes}/${agg.runs}`;
};
const avg = (sum: number, count: number): number => (count === 0 ? 0 : sum / count);
const ktok = (value: number): string => `${(value / 1000).toFixed(1)}k`;

/** `|` dentro de uma célula (ex.: o nome `any_of:a|b` de uma verificação) quebraria a tabela Markdown. */
const cell = (value: string): string => value.replace(/\|/g, "\\|");

function table(header: string[], rows: string[][]): string {
	return [`| ${header.map(cell).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}

const score = (value: number | null): string => (value === null ? "-" : value.toFixed(2));
/** `4.20 (disp. 10%)`; sem juiz: `-`. Com 1 juiz não há comparação, então não há taxa. */
const qualityCell = (quality: QualityAgg | undefined): string => {
	if (!quality || quality.judged === 0) return "-";
	const rate = disputedRate(quality);
	const extra = [rate === null ? "1 juiz" : `disp. ${pct(rate)}`, quality.disputedRuns > 0 ? `${quality.disputedRuns} cenário(s) em disputa` : "", quality.invalidRuns > 0 ? `${quality.invalidRuns} inválido(s)` : ""].filter(Boolean);
	return `${score(meanQuality(quality))} (${extra.join(", ")})`;
};

/** `2 corte(s) de tempo do runtime, 1 erro(s) do provedor`; `-` sem erros de execução. */
const errorKindsCell = (agg: Agg | undefined): string => {
	const parts = agg ? ERROR_KINDS.filter((kind) => agg.errorKinds[kind] > 0).map((kind) => `${agg.errorKinds[kind]} ${ERROR_KIND_LABELS[kind]}`) : [];
	return parts.join(", ") || "-";
};
/** Acerto só nas execuções sem erro de execução: `85% (17/20)`; `-` quando não sobrou nenhuma. */
const cleanCell = (agg: Agg | undefined): string => {
	if (!agg) return "-";
	const rate = cleanPassRateOf(agg);
	return rate === null ? "-" : `${pct(rate)} (${agg.passes}/${cleanRunsOf(agg)})`;
};

const failing = (agg: Agg): string =>
	Object.entries(agg.failing)
		.sort((a, b) => b[1] - a[1])
		.map(([name, count]) => `${name} (${count})`)
		.join(", ") || "-";

export const READING_LEGEND: Record<string, string> = {
	ok: "todos os modelos passam",
	"harness/instruções": "falha em TODOS os modelos (inclusive o forte): contexto, tool, contrato ou a própria expectativa",
	modelo: "passa no forte e falha só nos baratos (ou só em alguns modelos)",
	"instável": "as repetições divergem: olhar temperatura, prompt ambíguo, ordem de tools",
	inconclusivo: "um forte falha onde um barato passa: conferir a expectativa",
	"erro de execução": "todas as execuções acabaram em erro de execução (corte de tempo do runtime, erro do provedor): não diz nada sobre o modelo. Nos demais vereditos, essas execuções são desconsideradas e a nota diz quantas",
	indefinido: "sem dados suficientes (pulado pelo teto ou um só modelo fraco que falha)",
};

/**
 * Avisos de juiz inválido: cenário × motor × modelo em que TODOS os julgamentos vieram inválidos (o juiz errou o JSON,
 * caiu ou foi recusado). Sem isso a coluna de qualidade mostra só "-" e o relatório parece dizer "nada a julgar".
 */
export function judgeWarnings(summary: MatrixSummary): string[] {
	if (!summary.judging) return [];
	const out: string[] = [];
	for (const engine of summary.engines) {
		for (const model of summary.models) {
			const total = summary.byModel[engine]?.[model]?.quality;
			if (total && total.judged > 0 && total.invalidRuns === total.judged) out.push(`**Juiz inválido em tudo:** ${total.judged} de ${total.judged} julgamentos de \`${model}\` (${engine}) vieram inválidos; não há nota de qualidade para esse modelo. Confira o modelo do juiz (\`${summary.judging.models.join("`, `")}\`) e o formato da resposta dele.`);
		}
	}
	for (const scenario of summary.scenarios) {
		for (const engine of summary.engines) {
			for (const model of summary.models) {
				const quality = summary.cells[scenario.id]?.[engine]?.[model]?.quality;
				if (quality && quality.judged > 0 && quality.invalidRuns === quality.judged) out.push(`Sem nota em \`${scenario.id}\` · ${engine} · \`${model}\`: ${quality.judged} julgamento(s), todos inválidos.`);
			}
		}
	}
	return out;
}

export function formatMatrixReport(summary: MatrixSummary): string {
	const out: string[] = [];
	const total = summary.scenarios.length * summary.engines.length * summary.models.length * summary.repeat;
	out.push(`# Matriz de avaliação (${summary.mode === "simulate" ? "SIMULADA" : "real"})`, "");
	out.push(`- Data: ${summary.createdAt}`);
	out.push(`- Cenários: ${summary.scenarios.length} · motores: ${summary.engines.join(", ")} · modelos: ${summary.models.join(", ")} · repetições: ${summary.repeat} (${total} execuções planejadas)`);
	out.push(`- Gasto: ${usd(summary.spentUsd, summary.costUnknown)}${summary.judgeUsd > 0 ? ` (juiz ${usd(summary.judgeUsd)})` : ""} · teto: ${summary.capUsd === null ? "sem teto" : usd(summary.capUsd)}`);
	if (summary.judging) {
		const { models, maxGap } = summary.judging;
		out.push(`- Rubrica de qualidade (1 a 5): ${models.length} juiz(es) — ${models.join(", ")} · ${models.length > 1 ? `teto de discordância ${maxGap} (acima disso a dimensão fica \`disputed\` e sai da nota)` : "1 juiz, sem teto de discordância"} · só nos cenários com verificação \`judge\`.`);
	}
	for (const warning of judgeWarnings(summary)) out.push(`- ${warning}`);
	if (summary.budgetStopped) {
		const parts = [summary.skippedBudget > 0 ? `${summary.skippedBudget} de ${total} execuções ficaram \`skipped_budget\` (não rodaram: a estimativa não coube ou o teto já tinha sido atingido)` : "", summary.stoppedBudget > 0 ? `${summary.stoppedBudget} foram interrompidas em andamento (\`stopped_budget\`, custo parcial contado, sem nota de acerto)` : ""].filter(Boolean);
		out.push(`- **Teto atingido:** ${parts.join("; ")}. O teto vale para o início de cada execução e para o gasto real, cobrado a cada chamada; o gasto final pode passar dele só pelas chamadas que já estavam em andamento.`);
	}
	if (summary.costUnknown) out.push("- `*` = custo estimado pela tabela de preços (preço desconhecido, ou o provedor não informou o custo).");
	if (summary.mode === "simulate") out.push("- **Simulado:** modelos roteirizados com uso falso por provedor e falhas sintéticas nos modelos baratos. Exercita o pipeline; os números não dizem nada sobre nenhum modelo.");
	out.push("");

	out.push("## Por modelo", "");
	out.push(
		table(
			["motor", "modelo", "acerto", "acerto sem erros de execução", "erros de execução", "execuções", "pulados", "passos/exec", "tokens in/out por exec", "custo", "duração média"],
			summary.engines.flatMap((engine) =>
				summary.models.map((model) => {
					const agg = summary.byModel[engine]?.[model];
					if (!agg) return [engine, model, "-", "-", "-", "0", "0", "-", "-", usd(0), "-"];
					return [engine, model, `${pct(passRateOf(agg))} (${agg.passes}/${agg.runs})`, cleanCell(agg), errorKindsCell(agg), String(agg.runs), String(agg.skipped), avg(agg.steps, agg.runs).toFixed(1), `${ktok(avg(agg.promptTokens, agg.runs))} / ${ktok(avg(agg.completionTokens, agg.runs))}`, usd(agg.costUsd, agg.costUnknown), `${(avg(agg.durationMs, agg.runs) / 1000).toFixed(1)}s`];
				}),
			),
		),
		"",
	);
	out.push("`acerto` conta todas as execuções (erro de execução reprova). `acerto sem erros de execução` tira as que acabaram em corte de tempo do runtime ou erro do provedor, que não dizem nada sobre o modelo.", "");
	const runtimeTimeouts = summary.engines.flatMap((engine) => summary.models.map((model) => ({ engine, model, count: summary.byModel[engine]?.[model]?.errorKinds.runtime_timeout ?? 0 }))).filter((item) => item.count > 0);
	if (runtimeTimeouts.length > 0) {
		out.push(`**Corte de tempo do runtime:** ${runtimeTimeouts.map((item) => `${item.count} em \`${item.model}\` (${item.engine})`).join("; ")}. É defeito do harness (o runtime desistiu esperando o provedor ou estourou o prazo da decisão), não falha de raciocínio do modelo: não vai para a coluna "modelo" da leitura harness × modelo, mas também não some do acerto.`, "");
	}
	if (summary.engineDeltas.length > 0) {
		out.push("### Diferença entre motores (pontos percentuais de acerto)", "");
		out.push(table(["modelo", "motor", "base", "acerto base", "acerto", "Δ pp"], summary.engineDeltas.map((delta) => [delta.model, delta.engine, delta.base, pct(delta.basePassRate), pct(delta.passRate), delta.deltaPp === null ? "-" : `${delta.deltaPp > 0 ? "+" : ""}${delta.deltaPp}`])), "");
	}

	if (summary.judging) {
		out.push("### Qualidade (rubrica) por modelo", "");
		out.push(
			table(
				["motor", "modelo", "nota média (1-5)", "dimensões em disputa", "cenários em disputa", "inválidos", ...DIMENSIONS.map((dimension) => DIMENSION_LABELS[dimension])],
				summary.engines.flatMap((engine) =>
					summary.models.map((model) => {
						const quality = summary.byModel[engine]?.[model]?.quality;
						if (!quality || quality.judged === 0) return [engine, model, "-", "-", "-", "-", ...DIMENSIONS.map(() => "-")];
						const rate = disputedRate(quality);
						return [engine, model, score(meanQuality(quality)), rate === null ? "n/a (1 juiz)" : `${pct(rate)} (${quality.dimsDisputed}/${quality.dimsCompared})`, `${quality.disputedRuns}/${quality.judged}`, String(quality.invalidRuns), ...DIMENSIONS.map((dimension) => score(dimensionMean(quality, dimension)))];
					}),
				),
			),
			"",
		);
	}

	const gold = summary.bySet?.gold;
	const generic = summary.bySet?.generic;
	if (gold && generic) {
		out.push("### Ouro × genérico (acerto lado a lado)", "");
		out.push("Aceite do motor (04-avaliacao §1.1): a mudança só vale se melhorar ou manter os DOIS conjuntos. Ganho só no ouro, com o genérico parado ou caindo, é suspeito de vício no uso do dono.", "");
		out.push(
			table(
				["motor", "modelo", "ouro", "genérico", "Δ pp (genérico − ouro)"],
				summary.engines.flatMap((engine) =>
					summary.models.map((model) => {
						const goldRate = passRateOf(gold[engine]?.[model] ?? { runs: 0, passes: 0 });
						const genericRate = passRateOf(generic[engine]?.[model] ?? { runs: 0, passes: 0 });
						const delta = goldRate === null || genericRate === null ? "-" : `${Math.round((genericRate - goldRate) * 100) > 0 ? "+" : ""}${Math.round((genericRate - goldRate) * 100)}`;
						return [engine, model, `${pct(goldRate)} (${ratio(gold[engine]?.[model])})`, `${pct(genericRate)} (${ratio(generic[engine]?.[model])})`, delta];
					}),
				),
			),
			"",
		);
	}

	out.push("## Por provedor", "");
	out.push(table(["provedor", "execuções", "tokens in", "tokens out", "custo"], Object.entries(summary.byProvider).sort(([a], [b]) => a.localeCompare(b)).map(([provider, item]) => [provider, String(item.runs), ktok(item.promptTokens), ktok(item.completionTokens), usd(item.costUsd, item.costUnknown)])), "");

	const columns = summary.engines.flatMap((engine) => summary.models.map((model) => ({ engine, model })));
	const colName = (c: { engine: string; model: string }) => (summary.engines.length > 1 ? `${c.model} · ${c.engine}` : c.model);
	out.push("## Por capacidade (acertos/execuções)", "");
	out.push(
		table(
			["capacidade", ...columns.map(colName)],
			Object.keys(summary.byCapability)
				.sort()
				.map((capability) => [capability, ...columns.map((c) => ratio(summary.byCapability[capability]?.[c.engine]?.[c.model]))]),
		),
		"",
	);

	if (summary.judging) {
		out.push("## Qualidade por capacidade (nota média 1-5, discordância)", "");
		out.push(
			table(
				["capacidade", ...columns.map(colName)],
				Object.keys(summary.byCapability)
					.sort()
					.map((capability) => [capability, ...columns.map((c) => qualityCell(summary.byCapability[capability]?.[c.engine]?.[c.model]?.quality))]),
			),
			"",
		);
	}

	out.push("## Leitura: harness ou modelo? (por cenário)", "");
	out.push("Calculada pelo padrão de acertos entre os modelos (04-avaliacao §3), sem juiz:", "");
	for (const [verdict, text] of Object.entries(READING_LEGEND)) out.push(`- \`${verdict}\`: ${text}`);
	out.push("");
	out.push(
		table(
			["cenário", "capacidade", "motor", "leitura", "detalhe"],
			summary.scenarios.flatMap((scenario) => summary.engines.map((engine) => {
				const reading = summary.readings[scenario.id]?.[engine];
				return [scenario.id, scenario.capability, engine, reading?.verdict ?? "-", (reading?.reason ?? "").replace(/\|/g, "/")];
			})),
		),
		"",
	);

	out.push("## Detalhe por cenário × motor × modelo", "");
	out.push(
		table(
			["cenário", "motor", "modelo", "acertos", "erros de execução", "checks que falharam", ...(summary.judging ? ["qualidade"] : []), "passos", "tokens in/out", "custo", "duração", "pulados"],
			summary.scenarios.flatMap((scenario) =>
				summary.engines.flatMap((engine) =>
					summary.models.map((model) => {
						const agg = summary.cells[scenario.id]?.[engine]?.[model];
						if (!agg) return [scenario.id, engine, model, "-", "-", "-", ...(summary.judging ? ["-"] : []), "-", "-", "-", "-", "0"];
						return [scenario.id, engine, model, ratio(agg), errorKindsCell(agg), failing(agg), ...(summary.judging ? [qualityCell(agg.quality)] : []), avg(agg.steps, agg.runs).toFixed(1), `${ktok(avg(agg.promptTokens, agg.runs))} / ${ktok(avg(agg.completionTokens, agg.runs))}`, usd(agg.costUsd, agg.costUnknown), `${(avg(agg.durationMs, agg.runs) / 1000).toFixed(1)}s`, String(agg.skipped)];
					}),
				),
			),
		),
	);
	return out.join("\n");
}
