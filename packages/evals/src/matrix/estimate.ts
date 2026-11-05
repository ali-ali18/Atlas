import { buildJudgePrompt, buildJudgeSystem } from "../quality.js";
import type { Trajectory } from "../trajectory.js";
import { createScriptedModel } from "../engine-compare/scripted-model.js";
import { pool } from "../runner.js";
import { runScenario } from "../run-scenario.js";
import type { Scenario } from "../scenario.js";
import type { EngineAdapter } from "./engines.js";
import type { ResolvedModel } from "./models.js";
import { costFromTokens, priceFor, type PriceEntry } from "./pricing.js";
import { countThatFit } from "./budget.js";

/**
 * Estimativa sem rede: o tamanho de cada execução vem do roteiro mock do cenário (tokens ≈ caracteres/4, o prompt
 * cresce como o motor realmente monta), corrigido por três constantes calibradas nas execuções reais de 05/11:
 * - entrada e chamadas `DEFAULT_ESTIMATE_FACTOR`x o mock (o modelo real dá mais passos que o roteiro);
 * - cache: depois do 1º passo `CACHE_READ_SHARE` do prompt de cada chamada vem de cache (leitura a preço de cache);
 *   antes a conta ignorava o cache e custava ~1,4x a 2,6x o real;
 * - saída `COMPLETION_FACTOR`x o total do mock, sem multiplicar por `factor` (o roteiro responde curto; antes a
 *   estimativa ficava 1,6x a 4,5x abaixo da saída real).
 * O mesmo número alimenta `--estimate` e a reserva do teto de `--max-usd`.
 */

export type JudgeProfile = {
	/** Chamadas de juiz por juiz e execução: uma por verificação `judge` do cenário. */
	calls: number;
	/** Soma dos prompts (sistema + usuário) dessas chamadas, em tokens (caracteres/4), medidos com a trajetória do mock. */
	promptTokens: number;
};

export type ExecutionProfile = { modelCalls: number; promptTokens: number; completionTokens: number; fromMock: boolean; judge?: JudgeProfile };

/** Cenário sem roteiro mock: 8 chamadas de ~6k tokens de entrada e 400 de saída. */
export const FALLBACK_PROFILE: ExecutionProfile = { modelCalls: 8, promptTokens: 48_000, completionTokens: 3_200, fromMock: false };
/** Passos extras do modelo real sobre o roteiro (multiplica chamadas e entrada). Medido: 1,6x a 2,4x a entrada do mock. */
export const DEFAULT_ESTIMATE_FACTOR = 2;
/** Fração do prompt de cada chamada, a partir da 2ª, lida do cache do provedor. */
export const CACHE_READ_SHARE = 0.7;
/** Margem sobre a estimativa: a calibração erra ±15% entre modelos (medido em 05/11) e o teto prefere errar para cima. */
export const ESTIMATE_MARGIN = 1.15;
/** A saída TOTAL do modelo real é ~3x a do roteiro mock, qualquer que seja `factor` (medido: 2,1x a 3,1x). */
export const COMPLETION_FACTOR = 3;

export const profileKey = (scenarioId: string, engine: string): string => `${scenarioId}|${engine}`;

/** Perfil do cenário sem roteiro (ou com roteiro que não rodou): mesmo prompt do juiz, resposta de ~2k tokens. */
const FALLBACK_JUDGE_ANSWER_CHARS = 8000;

/** Chamadas e tamanho (tokens) dos prompts do juiz deste cenário, medidos com a trajetória dada (ou uma sintética). */
export function judgeProfileOf(scenario: Scenario, trajectory?: Trajectory): JudgeProfile | undefined {
	const judged = (scenario.expect ?? []).filter((item): item is Extract<typeof item, { type: "judge" }> => item.type === "judge");
	if (judged.length === 0) return undefined;
	const measured = trajectory ?? ({ text: "x".repeat(FALLBACK_JUDGE_ANSWER_CHARS), toolCalls: [], toolResults: [], events: [] } satisfies Pick<Trajectory, "text" | "toolCalls" | "toolResults" | "events">);
	const system = buildJudgeSystem(scenario).length;
	const chars = judged.reduce((sum, item) => sum + system + buildJudgePrompt({ rubric: item.rubric, scenario, trajectory: measured }).length, 0);
	return { calls: judged.length, promptTokens: Math.ceil(chars / 4) };
}

/**
 * Perfil a partir da trajetória do mock. Mock que errou ou que não fez nenhuma chamada ao modelo não mede nada
 * (estimativa 0 deixaria a reserva do teto passar tudo): vale o perfil de reserva.
 */
export function profileFromMock(scenario: Scenario, trajectory: Trajectory): ExecutionProfile {
	const judge = judgeProfileOf(scenario, trajectory);
	if (trajectory.error || trajectory.modelCalls.length === 0) return { ...FALLBACK_PROFILE, ...(judgeProfileOf(scenario) ? { judge: judgeProfileOf(scenario)! } : {}) };
	return { modelCalls: trajectory.modelCalls.length, promptTokens: trajectory.tokens.prompt, completionTokens: trajectory.tokens.completion, fromMock: true, ...(judge ? { judge } : {}) };
}

export async function profileScenarios(
	scenarios: readonly Scenario[],
	engines: readonly EngineAdapter[],
	options: { concurrency?: number; timeoutMs?: number } = {},
): Promise<Map<string, ExecutionProfile>> {
	const out = new Map<string, ExecutionProfile>();
	const jobs = scenarios.flatMap((scenario) => engines.map((engine) => ({ scenario, engine })));
	await pool(jobs, options.concurrency ?? 3, async ({ scenario, engine }) => {
		const key = profileKey(scenario.id, engine.id);
		const fallback: ExecutionProfile = { ...FALLBACK_PROFILE, ...(judgeProfileOf(scenario) ? { judge: judgeProfileOf(scenario)! } : {}) };
		if (!scenario.mock) {
			out.set(key, fallback);
			return;
		}
		try {
			const trajectory = await runScenario(engine.patchScenario(scenario), {
				model: "mock/scripted",
				apiKey: "",
				streamChat: createScriptedModel(scenario.mock.turns),
				variant: engine.id,
				timeoutMs: options.timeoutMs ?? 60_000,
				...(engine.runOptions?.() ?? {}),
			});
			out.set(key, profileFromMock(scenario, trajectory));
		} catch {
			out.set(key, fallback);
		}
	});
	return out;
}

/**
 * Custo estimado de UMA execução. O preço é aplicado por chamada média (o corte de contexto longo é por chamada) e o
 * cache entra assim: a 1ª chamada grava o prefixo e as seguintes leem `CACHE_READ_SHARE` do prompt do cache. `factor`
 * multiplica as chamadas; `ESTIMATE_MARGIN` cobre o erro da calibração; a saída total é `COMPLETION_FACTOR`x a do mock, repartida entre elas.
 */
export function estimateExecutionUsd(profile: ExecutionProfile, price: PriceEntry, factor: number): number {
	const modelCalls = Math.max(1, profile.modelCalls);
	const promptTokens = Math.ceil(profile.promptTokens / modelCalls);
	const calls = modelCalls * factor;
	const completionTokens = Math.ceil((profile.completionTokens * COMPLETION_FACTOR) / Math.max(1, calls));
	const cached = Math.round(promptTokens * CACHE_READ_SHARE);
	const first = costFromTokens({ promptTokens, completionTokens, cacheWriteTokens: cached }, price);
	const later = costFromTokens({ promptTokens, completionTokens, cachedTokens: cached }, price);
	return (first * Math.min(1, calls) + later * Math.max(0, calls - 1)) * ESTIMATE_MARGIN;
}

export type EstimateRow = { engine: string; model: string; provider: string; executions: number; promptTokens: number; completionTokens: number; usd: number; priceKnown: boolean; priceConfirmed: boolean };
export type JudgeEstimateRow = { model: string; provider: string; calls: number; promptTokens: number; completionTokens: number; usd: number; priceKnown: boolean; priceConfirmed: boolean };
export type EstimateResult = { rows: EstimateRow[]; judgeRows: JudgeEstimateRow[]; totalUsd: number; executions: number; factor: number; repeat: number; anyUnknown: boolean; anyUnconfirmed: boolean; fitsInCap?: { capUsd: number; executions: number } };

export function buildEstimate(input: {
	scenarios: readonly Scenario[];
	engines: readonly EngineAdapter[];
	models: readonly ResolvedModel[];
	repeat: number;
	profiles: ReadonlyMap<string, ExecutionProfile>;
	factor: number;
	capUsd?: number;
	/** Juízes da rubrica: cada execução de cenário com verificação `judge` chama cada juiz uma vez. */
	judges?: readonly ResolvedModel[];
	priceTable?: Record<string, PriceEntry>;
}): EstimateResult {
	const rows: EstimateRow[] = [];
	for (const engine of input.engines) {
		for (const model of input.models) {
			const { price, known } = priceFor(model.priceKey, input.priceTable);
			let promptTokens = 0;
			let completionTokens = 0;
			let usd = 0;
			for (const scenario of input.scenarios) {
				const profile = input.profiles.get(profileKey(scenario.id, engine.id)) ?? FALLBACK_PROFILE;
				promptTokens += profile.promptTokens * input.factor * input.repeat;
				completionTokens += profile.completionTokens * COMPLETION_FACTOR * input.repeat;
				usd += estimateExecutionUsd(profile, price, input.factor) * input.repeat;
			}
			rows.push({ engine: engine.id, model: model.spec, provider: model.provider, executions: input.scenarios.length * input.repeat, promptTokens: Math.round(promptTokens), completionTokens: Math.round(completionTokens), usd, priceKnown: known, priceConfirmed: known && price.confirmed });
		}
	}
	const judgeRows: JudgeEstimateRow[] = (input.judges ?? []).map((judge) => {
		const { known, price } = priceFor(judge.priceKey, input.priceTable);
		let calls = 0;
		let promptTokens = 0;
		let usd = 0;
		for (const scenario of input.scenarios.filter(hasJudgeExpectation)) {
			for (const engine of input.engines) {
				const profile = input.profiles.get(profileKey(scenario.id, engine.id)) ?? FALLBACK_PROFILE;
				const measured = profile.judge ?? FALLBACK_JUDGE;
				const times = input.models.length * input.repeat;
				calls += measured.calls * times;
				promptTokens += measured.promptTokens * times;
				usd += estimateJudgeUsd([judge], profile, input.priceTable) * times;
			}
		}
		return { model: judge.spec, provider: judge.provider, calls, promptTokens, completionTokens: calls * JUDGE_COMPLETION_TOKENS, usd, priceKnown: known, priceConfirmed: known && price.confirmed };
	});
	const result: EstimateResult = {
		rows,
		judgeRows,
		totalUsd: rows.reduce((sum, row) => sum + row.usd, 0) + judgeRows.reduce((sum, row) => sum + row.usd, 0),
		executions: rows.reduce((sum, row) => sum + row.executions, 0),
		factor: input.factor,
		repeat: input.repeat,
		anyUnknown: [...rows, ...judgeRows].some((row) => !row.priceKnown),
		anyUnconfirmed: [...rows, ...judgeRows].some((row) => !row.priceConfirmed),
	};
	return input.capUsd === undefined ? result : { ...result, fitsInCap: { capUsd: input.capUsd, executions: countThatFit(estimatesInOrder(input), input.capUsd) } };
}

/** Estimativa de cada execução na ordem de agendamento do matrix (repetição → cenário → motor → modelo). */
export function estimatesInOrder(input: { judges?: readonly ResolvedModel[]; scenarios: readonly Scenario[]; engines: readonly EngineAdapter[]; models: readonly ResolvedModel[]; repeat: number; profiles: ReadonlyMap<string, ExecutionProfile>; factor: number; priceTable?: Record<string, PriceEntry> }): number[] {
	const out: number[] = [];
	for (let repeat = 0; repeat < input.repeat; repeat += 1) {
		for (const scenario of input.scenarios) {
			for (const engine of input.engines) {
				const profile = input.profiles.get(profileKey(scenario.id, engine.id)) ?? FALLBACK_PROFILE;
				const judgeUsd = hasJudgeExpectation(scenario) ? estimateJudgeUsd(input.judges ?? [], profile, input.priceTable) : 0;
				for (const model of input.models) out.push(estimateExecutionUsd(profile, priceFor(model.priceKey, input.priceTable).price, input.factor) + judgeUsd);
			}
		}
	}
	return out;
}

/** Saída do juiz: o JSON da rubrica (4 dimensões com uma frase cada), ~250 tokens. */
export const JUDGE_COMPLETION_TOKENS = 250;
/** Sem perfil medido (cenário fora do mapa): uma chamada de ~3k tokens. */
const FALLBACK_JUDGE: JudgeProfile = { calls: 1, promptTokens: 3000 };

/** Só os cenários com verificação `judge` são julgados. */
export const hasJudgeExpectation = (scenario: Pick<Scenario, "expect">): boolean => (scenario.expect ?? []).some((item) => item.type === "judge");

/**
 * Custo estimado do julgamento de UMA execução (todos os juízes): o tamanho do prompt vem do perfil do cenário (prompt
 * real do juiz montado com a trajetória do mock) e a saída é `JUDGE_COMPLETION_TOKENS` por chamada. Sem cache.
 */
export function estimateJudgeUsd(judges: readonly ResolvedModel[], profile: ExecutionProfile, priceTable?: Record<string, PriceEntry>): number {
	const measured = profile.judge ?? FALLBACK_JUDGE;
	const promptTokens = Math.ceil(measured.promptTokens / measured.calls);
	return judges.reduce((sum, judge) => sum + measured.calls * costFromTokens({ promptTokens, completionTokens: JUDGE_COMPLETION_TOKENS }, priceFor(judge.priceKey, priceTable).price), 0);
}

const usd = (value: number): string => `US$ ${value.toFixed(4)}`;
const tok = (value: number): string => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : `${(value / 1000).toFixed(0)}k`);

export function formatEstimate(result: EstimateResult): string {
	const header = ["motor", "modelo", "execuções", "tokens in", "tokens out", "custo estimado", "preço"];
	const priceNote = (row: { priceKnown: boolean; priceConfirmed: boolean }) => (row.priceKnown ? (row.priceConfirmed ? "ok" : "a confirmar") : "desconhecido (padrão conservador)");
	const body = [
		...result.rows.map((row) => [row.engine, row.model, String(row.executions), tok(row.promptTokens), tok(row.completionTokens), usd(row.usd), priceNote(row)]),
		...result.judgeRows.map((row) => ["juiz", row.model, `${row.calls} chamadas`, tok(row.promptTokens), tok(row.completionTokens), usd(row.usd), priceNote(row)]),
	];
	const rows = [header, ...body, ["", "TOTAL", String(result.executions), "", "", usd(result.totalUsd), ""]];
	const widths = header.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
	const lines = rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ").trimEnd());
	lines.splice(1, 0, widths.map((width) => "-".repeat(width)).join("-+-"));
	const notes = [`estimativa sem rede: tamanho do roteiro mock × ${result.factor} (passos extras do modelo real) × ${result.repeat} repetição(ões); depois do 1º passo ${Math.round(CACHE_READ_SHARE * 100)}% do prompt lido do cache; saída total ${COMPLETION_FACTOR}x a do roteiro; margem de ${Math.round((ESTIMATE_MARGIN - 1) * 100)}%.`];
	if (result.judgeRows.length > 0) notes.push(`juízes: prompt real do juiz do cenário (montado com a trajetória do mock) + ${JUDGE_COMPLETION_TOKENS} tokens de saída por chamada, uma por juiz e verificação \`judge\` (entra no total e no teto --max-usd).`);
	if (result.anyUnconfirmed) notes.push("há preços marcados \"a confirmar\" em src/matrix/pricing.ts: confira antes de confiar no total.");
	if (result.fitsInCap) notes.push(`teto --max-usd ${usd(result.fitsInCap.capUsd)}: cabem ${result.fitsInCap.executions} de ${result.executions} execuções${result.fitsInCap.executions < result.executions ? " (o resto seria pulado)" : ""}.`);
	return [...lines, "", ...notes].join("\n");
}
