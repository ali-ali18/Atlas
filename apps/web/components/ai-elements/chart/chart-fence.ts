import { parseChartSpec, type ChartSpec } from "@workspace/shared";

export type ChartFence =
	| { kind: "chart"; spec: ChartSpec }
	/** JSON ainda chegando (bloco aberto no streaming): mostra o espaço reservado. */
	| { kind: "pending" }
	/** Bloco fechado, mas inválido ou incompleto: mostra o código com um aviso. */
	| { kind: "invalid"; error: string };

/** Decide o que um bloco ```chart vira: gráfico, espaço reservado (streaming) ou código com aviso. */
export function resolveChartFence(code: string, streaming: boolean): ChartFence {
	const text = code.trim();
	if (!text) return streaming ? { kind: "pending" } : { kind: "invalid", error: "o bloco está vazio" };
	const parsed = parseChartSpec(text);
	if (parsed.ok) return { kind: "chart", spec: parsed.spec };
	return streaming ? { kind: "pending" } : { kind: "invalid", error: parsed.error };
}
