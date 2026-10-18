import type { JevTelemetry } from "@workspace/shared";
import type { JevDecisionRecord } from "../jev/decide.js";

/**
 * F0 — agrega as decisões do Jev de um run, SEPARADO do uso principal
 * (`usageTotals`). O endpoint de decisões não informa custo: `costUsd` fica
 * `null` (desconhecido), nunca 0. Só metadados: feature, duração, modelo,
 * tokens de entrada; as respostas (`answers`) não entram.
 */
export function createJevTelemetryCollector() {
	const byFeature = new Map<string, { calls: number; totalMs: number }>();
	const models = new Set<string>();
	let calls = 0;
	let totalMs = 0;
	let answered = 0;
	let unavailable = 0;
	let inputTokens = 0;

	return {
		record(entry: JevDecisionRecord): void {
			calls += 1;
			const ms =
				typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)
					? Math.max(0, Math.round(entry.durationMs))
					: 0;
			totalMs += ms;
			if (entry.source === "jev") answered += 1;
			else unavailable += 1;
			if (entry.model) models.add(entry.model);
			if (typeof entry.inputTokens === "number" && Number.isFinite(entry.inputTokens)) {
				inputTokens += Math.max(0, entry.inputTokens);
			}
			const current = byFeature.get(entry.feature) ?? { calls: 0, totalMs: 0 };
			byFeature.set(entry.feature, {
				calls: current.calls + 1,
				totalMs: current.totalMs + ms,
			});
		},
		snapshot(): JevTelemetry | undefined {
			if (calls === 0) return undefined;
			return {
				calls,
				totalMs,
				answered,
				unavailable,
				inputTokens,
				models: [...models].sort(),
				byFeature: Object.fromEntries(byFeature),
				costUsd: null,
			};
		},
	};
}

export type JevTelemetryCollector = ReturnType<typeof createJevTelemetryCollector>;
