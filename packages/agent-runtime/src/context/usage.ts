import type { ContextUsageEvent } from "@workspace/shared";

/**
 * Medidor de contexto de runs de código: depois de cada passo do modelo o runtime
 * informa quanto da janela está em uso e onde o resumo automático dispara. Só
 * emite quando o uso muda pelo menos `minDeltaRatio` da janela (1%) desde o último
 * evento (ou na primeira medição), para não inundar o stream e o histórico.
 */
export const CONTEXT_USAGE_MIN_DELTA_RATIO = 0.01;

export type ContextUsageSample = { model?: string; usedTokens: number; windowTokens: number; compactAtTokens: number; sessionId?: string };

export function createContextUsageReporter(
	emit: (event: ContextUsageEvent) => void | Promise<void>,
	minDeltaRatio = CONTEXT_USAGE_MIN_DELTA_RATIO,
) {
	let last: { used: number; window: number; model?: string } | null = null;
	return async function report(sample: ContextUsageSample): Promise<boolean> {
		const usedTokens = Math.max(0, Math.round(sample.usedTokens));
		const windowTokens = Math.round(sample.windowTokens);
		if (!(windowTokens > 0)) return false;
		if (last && last.window === windowTokens && last.model === sample.model && Math.abs(usedTokens - last.used) < windowTokens * minDeltaRatio) return false;
		last = { used: usedTokens, window: windowTokens, model: sample.model };
		await emit({
			type: "context_usage",
			...(sample.sessionId ? { sessionId: sample.sessionId } : {}),
			...(sample.model ? { model: sample.model } : {}),
			usedTokens,
			windowTokens,
			compactAtTokens: Math.min(windowTokens, Math.max(1, Math.round(sample.compactAtTokens))),
		});
		return true;
	};
}
