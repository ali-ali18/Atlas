/**
 * Diagnóstico "modelo x harness" por cenário (função pura). Compara a taxa de acerto dos modelos fortes com a dos
 * fracos: forte passa e fraco falha → o limite é do modelo; todos falham → o problema está no harness (prompt,
 * tools, travas) ou na expectativa; resultado que varia entre repetições → instável.
 */

export type Verdict = "ok" | "modelo" | "harness/instruções" | "instável" | "inconclusivo" | "erro de execução" | "indefinido";

export type CellStat = {
	runs: number;
	passes: number;
	/** Execuções que terminaram em exceção ou timeout. */
	errors: number;
	/** Verificação → quantas execuções falharam nela. */
	failing: Record<string, number>;
	costUsd: number;
	costUnknown: boolean;
};

export type ModelStat = CellStat & { model: string };

export const passRate = (stat: Pick<CellStat, "runs" | "passes">): number => (stat.runs === 0 ? 0 : stat.passes / stat.runs);

/** Modelos tratados como "fortes" quando o usuário não diz quais são (`--strong`). */
export const DEFAULT_STRONG = /anthropic\/claude-(opus|sonnet)|openai\/gpt-5|openai\/o\d|google\/gemini-[\d.]+-pro/i;

export function strongMatcher(list?: string[]): (model: string) => boolean {
	if (list && list.length > 0) {
		const set = new Set(list);
		return (model) => set.has(model);
	}
	return (model) => DEFAULT_STRONG.test(model);
}

export function diagnose(stats: ModelStat[], isStrong: (model: string) => boolean): { verdict: Verdict; reason: string } {
	const ran = stats.filter((stat) => stat.runs > 0);
	if (ran.length === 0) return { verdict: "indefinido", reason: "nenhuma execução" };
	if (ran.every((stat) => stat.errors === stat.runs)) return { verdict: "erro de execução", reason: "todas as execuções falharam antes de responder (rede, chave, timeout)" };
	const rate = (stat: ModelStat) => passRate(stat);
	const partial = (stat: ModelStat) => rate(stat) > 0 && rate(stat) < 1;
	if (ran.every((stat) => rate(stat) === 1)) return { verdict: "ok", reason: "todos os modelos passam" };
	const strong = ran.filter((stat) => isStrong(stat.model));
	const weak = ran.filter((stat) => !isStrong(stat.model));
	if (ran.every((stat) => rate(stat) === 0)) {
		if (ran.length === 1 && strong.length === 0) return { verdict: "indefinido", reason: "só um modelo (fraco) e ele falha: rode também com um modelo forte" };
		return { verdict: "harness/instruções", reason: "nenhum modelo passa: revisar prompt, tools, travas ou a própria expectativa" };
	}
	if (strong.length > 0 && weak.length > 0) {
		if (strong.every((stat) => rate(stat) === 1) && weak.some((stat) => rate(stat) < 1)) {
			return { verdict: "modelo", reason: `forte(s) passam; falham: ${weak.filter((stat) => rate(stat) < 1).map((stat) => stat.model).join(", ")}` };
		}
		if (strong.some((stat) => rate(stat) === 0) && weak.some((stat) => rate(stat) === 1)) {
			return { verdict: "inconclusivo", reason: "um modelo forte falha onde um fraco passa: conferir a expectativa do cenário" };
		}
	}
	if (ran.some(partial)) return { verdict: "instável", reason: `varia entre repetições: ${ran.filter(partial).map((stat) => `${stat.model} ${stat.passes}/${stat.runs}`).join(", ")}` };
	return { verdict: "modelo", reason: `passa com ${ran.filter((stat) => rate(stat) === 1).map((stat) => stat.model).join(", ")}; o harness consegue` };
}

/** Diferença de taxa de acerto (variante − base) por cenário e modelo, em pontos percentuais. */
export function passRateDelta(base: CellStat | undefined, variant: CellStat | undefined): number | null {
	if (!base || !variant || base.runs === 0 || variant.runs === 0) return null;
	return Math.round((passRate(variant) - passRate(base)) * 100);
}
