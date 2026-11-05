import { createScriptedModel } from "../engine-compare/scripted-model.js";
import type { MockTurn, Scenario } from "../scenario.js";
import type { MatrixProviders } from "./providers.js";
import type { ResolvedModel } from "./models.js";

/**
 * `--simulate`: o matrix inteiro (roteamento por prefixo, custo pela tabela, teto, agregação, relatório) sem rede.
 * Cada provedor falso responde com o roteiro mock do cenário e devolve o uso NO FORMATO do provedor real (Anthropic:
 * `costUnknown`; OpenCode Go: `costKind: "plan"`; OpenRouter: `costUsd`), com uma escala de tokens por provedor.
 * Modelos "baratos" falham de forma determinística em parte das execuções (semente = modelo+cenário+motor+repetição):
 * isso exercita pass rate, falhas e os vereditos modelo × harness. NÃO mede nenhum modelo.
 */

export const SIM_TOKEN_SCALE: Record<ResolvedModel["provider"], number> = { anthropic: 1, "opencode-go": 1.25, openrouter: 1.1 };

/** Chance de a execução simulada "errar" (roteiro cortado). Forte nunca erra. */
export function simulatedFailRate(model: ResolvedModel): number {
	if (/sonnet|opus/i.test(model.slug)) return 0;
	if (/haiku/i.test(model.slug)) return 0.15;
	return 0.35;
}

/** FNV-1a de 32 bits → [0, 1). */
export function seededUnit(seed: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < seed.length; index += 1) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash / 0x1_0000_0000;
}

export type SimJob = { scenario: Scenario; engine: string; model: ResolvedModel; repeat: number };

/** Roteiro degradado: o modelo "desiste" e responde sem chamar nenhuma tool. */
function degradedTurns(turns: readonly MockTurn[]): MockTurn[] {
	const lastSay = [...turns].reverse().find((turn): turn is Extract<MockTurn, { say: string }> => "say" in turn);
	return [{ say: lastSay?.say ?? "Pronto." }];
}

export function simulatedProviders(job: SimJob): MatrixProviders {
	const turns = job.scenario.mock?.turns ?? [{ say: "(sem roteiro)" }];
	const failed = seededUnit(`${job.model.spec}|${job.scenario.id}|${job.engine}|${job.repeat}`) < simulatedFailRate(job.model);
	const script = createScriptedModel(failed ? degradedTurns(turns) : turns);
	const scale = SIM_TOKEN_SCALE[job.model.provider];
	const make = (shape: (usage: { promptTokens: number; completionTokens: number }) => Record<string, unknown>): MatrixProviders["anthropic"] =>
		(async (params, handlers) => {
			const result = await script(params, handlers);
			const base = { promptTokens: Math.round((result.usage?.promptTokens ?? 0) * scale), completionTokens: Math.round((result.usage?.completionTokens ?? 0) * scale) };
			return { ...result, usage: { ...base, totalTokens: base.promptTokens + base.completionTokens, ...shape(base) } };
		}) as MatrixProviders["anthropic"];
	return {
		// Mesma convenção dos adaptadores reais: parte do prompt vem de cache, e o custo não é informado.
		anthropic: make((usage) => ({ cachedTokens: Math.floor(usage.promptTokens * 0.5), costUnknown: true })),
		opencodeGo: make(() => ({ costKind: "plan" })),
		// OpenRouter informa o custo real: aqui, um preço fixo de "classe barata".
		openrouter: make((usage) => ({ costUsd: (usage.promptTokens * 0.2 + usage.completionTokens * 0.8) / 1_000_000 })),
	};
}
