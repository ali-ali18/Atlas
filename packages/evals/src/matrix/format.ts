import { DIMENSIONS, DIMENSION_LABELS, dimensionMean, disputedRate, meanQuality, type QualityAgg } from "../quality.js";
import { passRateOf, type Agg, type MatrixSummary } from "./aggregate.js";

/** Relatório Markdown do matrix (determinístico: só formata o resumo). */

const usd = (value: number, unknown = false): string => `US$ ${value.toFixed(4)}${unknown ? "*" : ""}`;
const pct = (rate: number | null): string => (rate === null ? "-" : `${Math.round(rate * 100)}%`);
const ratio = (agg: Agg | undefined): string => (!agg || agg.runs === 0 ? (agg && agg.skipped > 0 ? `pulado (${agg.skipped})` : "-") : `${agg.passes}/${agg.runs}`);
const avg = (sum: number, count: number): number => (count === 0 ? 0 : sum / count);
const ktok = (value: number): string => `${(value / 1000).toFixed(1)}k`;

function table(header: string[], rows: string[][]): string {
	return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

const score = (value: number | null): string => (value === null ? "-" : value.toFixed(2));
/** `4.20 (disp. 10%)`; sem juiz: `-`. Com 1 juiz não há comparação, então não há taxa. */
const qualityCell = (quality: QualityAgg | undefined): string => {
	if (!quality || quality.judged === 0) return "-";
	const rate = disputedRate(quality);
	const extra = [rate === null ? "1 juiz" : `disp. ${pct(rate)}`, quality.disputedRuns > 0 ? `${quality.disputedRuns} cenário(s) em disputa` : "", quality.invalidRuns > 0 ? `${quality.invalidRuns} inválido(s)` : ""].filter(Boolean);
	return `${score(meanQuality(quality))} (${extra.join(", ")})`;
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
	"erro de execução": "todas as execuções acabaram em erro (chave, rede, tempo)",
	indefinido: "sem dados suficientes (pulado pelo teto ou um só modelo fraco que falha)",
};

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
	if (summary.budgetStopped) out.push(`- **Teto atingido:** ${summary.skippedBudget} de ${total} execuções ficaram \`skipped_budget\` (não rodaram).`);
	if (summary.costUnknown) out.push("- `*` = custo estimado pela tabela de preços (preço desconhecido, ou o provedor não informou o custo).");
	if (summary.mode === "simulate") out.push("- **Simulado:** modelos roteirizados com uso falso por provedor e falhas sintéticas nos modelos baratos. Exercita o pipeline; os números não dizem nada sobre nenhum modelo.");
	out.push("");

	out.push("## Por modelo", "");
	out.push(
		table(
			["motor", "modelo", "acerto", "execuções", "pulados", "passos/exec", "tokens in/out por exec", "custo", "duração média"],
			summary.engines.flatMap((engine) =>
				summary.models.map((model) => {
					const agg = summary.byModel[engine]?.[model];
					if (!agg) return [engine, model, "-", "0", "0", "-", "-", usd(0), "-"];
					return [engine, model, `${pct(passRateOf(agg))} (${agg.passes}/${agg.runs})`, String(agg.runs), String(agg.skipped), avg(agg.steps, agg.runs).toFixed(1), `${ktok(avg(agg.promptTokens, agg.runs))} / ${ktok(avg(agg.completionTokens, agg.runs))}`, usd(agg.costUsd, agg.costUnknown), `${(avg(agg.durationMs, agg.runs) / 1000).toFixed(1)}s`];
				}),
			),
		),
		"",
	);
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
			["cenário", "motor", "modelo", "acertos", "checks que falharam", ...(summary.judging ? ["qualidade"] : []), "passos", "tokens in/out", "custo", "duração", "pulados"],
			summary.scenarios.flatMap((scenario) =>
				summary.engines.flatMap((engine) =>
					summary.models.map((model) => {
						const agg = summary.cells[scenario.id]?.[engine]?.[model];
						if (!agg) return [scenario.id, engine, model, "-", "-", ...(summary.judging ? ["-"] : []), "-", "-", "-", "-", "0"];
						return [scenario.id, engine, model, ratio(agg), failing(agg), ...(summary.judging ? [qualityCell(agg.quality)] : []), avg(agg.steps, agg.runs).toFixed(1), `${ktok(avg(agg.promptTokens, agg.runs))} / ${ktok(avg(agg.completionTokens, agg.runs))}`, usd(agg.costUsd, agg.costUnknown), `${(avg(agg.durationMs, agg.runs) / 1000).toFixed(1)}s`, String(agg.skipped)];
					}),
				),
			),
		),
	);
	return out.join("\n");
}
