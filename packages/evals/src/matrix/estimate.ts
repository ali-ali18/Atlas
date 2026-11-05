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
 * cresce como o motor realmente monta), multiplicado por `factor` porque modelo real dá mais passos que o roteiro.
 * O mesmo número alimenta `--estimate` e a reserva do teto de `--max-usd`.
 */

export type ExecutionProfile = { modelCalls: number; promptTokens: number; completionTokens: number; fromMock: boolean };

/** Cenário sem roteiro mock: 8 chamadas de ~6k tokens de entrada e 400 de saída. */
export const FALLBACK_PROFILE: ExecutionProfile = { modelCalls: 8, promptTokens: 48_000, completionTokens: 3_200, fromMock: false };
/** Modelo real dá mais passos e respostas mais longas que o roteiro. */
export const DEFAULT_ESTIMATE_FACTOR = 2;

export const profileKey = (scenarioId: string, engine: string): string => `${scenarioId}|${engine}`;

export async function profileScenarios(
	scenarios: readonly Scenario[],
	engines: readonly EngineAdapter[],
	options: { concurrency?: number; timeoutMs?: number } = {},
): Promise<Map<string, ExecutionProfile>> {
	const out = new Map<string, ExecutionProfile>();
	const jobs = scenarios.flatMap((scenario) => engines.map((engine) => ({ scenario, engine })));
	await pool(jobs, options.concurrency ?? 3, async ({ scenario, engine }) => {
		const key = profileKey(scenario.id, engine.id);
		if (!scenario.mock) {
			out.set(key, FALLBACK_PROFILE);
			return;
		}
		const trajectory = await runScenario(engine.patchScenario(scenario), {
			model: "mock/scripted",
			apiKey: "",
			streamChat: createScriptedModel(scenario.mock.turns),
			variant: engine.id,
			timeoutMs: options.timeoutMs ?? 60_000,
			...(engine.runOptions?.() ?? {}),
		});
		out.set(key, { modelCalls: trajectory.modelCalls.length, promptTokens: trajectory.tokens.prompt, completionTokens: trajectory.tokens.completion, fromMock: true });
	});
	return out;
}

/** Custo estimado de UMA execução (sem desconto de cache: conservador). */
export function estimateExecutionUsd(profile: ExecutionProfile, price: PriceEntry, factor: number): number {
	return costFromTokens({ promptTokens: Math.ceil(profile.promptTokens * factor), completionTokens: Math.ceil(profile.completionTokens * factor) }, { ...price, cachedRatio: 1, writeRatio: 1 });
}

export type EstimateRow = { engine: string; model: string; provider: string; executions: number; promptTokens: number; completionTokens: number; usd: number; priceKnown: boolean; priceConfirmed: boolean };
export type EstimateResult = { rows: EstimateRow[]; totalUsd: number; executions: number; factor: number; repeat: number; anyUnknown: boolean; anyUnconfirmed: boolean; fitsInCap?: { capUsd: number; executions: number } };

export function buildEstimate(input: {
	scenarios: readonly Scenario[];
	engines: readonly EngineAdapter[];
	models: readonly ResolvedModel[];
	repeat: number;
	profiles: ReadonlyMap<string, ExecutionProfile>;
	factor: number;
	capUsd?: number;
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
				completionTokens += profile.completionTokens * input.factor * input.repeat;
				usd += estimateExecutionUsd(profile, price, input.factor) * input.repeat;
			}
			rows.push({ engine: engine.id, model: model.spec, provider: model.provider, executions: input.scenarios.length * input.repeat, promptTokens: Math.round(promptTokens), completionTokens: Math.round(completionTokens), usd, priceKnown: known, priceConfirmed: known && price.confirmed });
		}
	}
	const result: EstimateResult = {
		rows,
		totalUsd: rows.reduce((sum, row) => sum + row.usd, 0),
		executions: rows.reduce((sum, row) => sum + row.executions, 0),
		factor: input.factor,
		repeat: input.repeat,
		anyUnknown: rows.some((row) => !row.priceKnown),
		anyUnconfirmed: rows.some((row) => !row.priceConfirmed),
	};
	return input.capUsd === undefined ? result : { ...result, fitsInCap: { capUsd: input.capUsd, executions: countThatFit(estimatesInOrder(input), input.capUsd) } };
}

/** Estimativa de cada execução na ordem de agendamento do matrix (repetição → cenário → motor → modelo). */
export function estimatesInOrder(input: { scenarios: readonly Scenario[]; engines: readonly EngineAdapter[]; models: readonly ResolvedModel[]; repeat: number; profiles: ReadonlyMap<string, ExecutionProfile>; factor: number; priceTable?: Record<string, PriceEntry> }): number[] {
	const out: number[] = [];
	for (let repeat = 0; repeat < input.repeat; repeat += 1) {
		for (const scenario of input.scenarios) {
			for (const engine of input.engines) {
				const profile = input.profiles.get(profileKey(scenario.id, engine.id)) ?? FALLBACK_PROFILE;
				for (const model of input.models) out.push(estimateExecutionUsd(profile, priceFor(model.priceKey, input.priceTable).price, input.factor));
			}
		}
	}
	return out;
}

const usd = (value: number): string => `US$ ${value.toFixed(4)}`;
const tok = (value: number): string => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : `${(value / 1000).toFixed(0)}k`);

export function formatEstimate(result: EstimateResult): string {
	const header = ["motor", "modelo", "execuções", "tokens in", "tokens out", "custo estimado", "preço"];
	const body = result.rows.map((row) => [row.engine, row.model, String(row.executions), tok(row.promptTokens), tok(row.completionTokens), usd(row.usd), row.priceKnown ? (row.priceConfirmed ? "ok" : "a confirmar") : "desconhecido (padrão conservador)"]);
	const rows = [header, ...body, ["", "TOTAL", String(result.executions), "", "", usd(result.totalUsd), ""]];
	const widths = header.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
	const lines = rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ").trimEnd());
	lines.splice(1, 0, widths.map((width) => "-".repeat(width)).join("-+-"));
	const notes = [`estimativa sem rede: tamanho do roteiro mock × ${result.factor} (fator de passos extras do modelo real) × ${result.repeat} repetição(ões); sem desconto de cache.`];
	if (result.anyUnconfirmed) notes.push("há preços marcados \"a confirmar\" em src/matrix/pricing.ts: confira antes de confiar no total.");
	if (result.fitsInCap) notes.push(`teto --max-usd ${usd(result.fitsInCap.capUsd)}: cabem ${result.fitsInCap.executions} de ${result.executions} execuções${result.fitsInCap.executions < result.executions ? " (o resto seria pulado)" : ""}.`);
	return [...lines, "", ...notes].join("\n");
}
