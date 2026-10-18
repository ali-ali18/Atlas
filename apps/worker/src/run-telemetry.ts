import type { RuntimeStepRecord } from "@workspace/agent-runtime";
import type { JevTelemetry, RunTelemetryMeta, RunUsage } from "@workspace/shared";

/**
 * F0 — telemetria no worker. Só metadados (tempos, contadores, ids de modelo):
 * nada de conteúdo de mensagem, prompt, args/resultado de tool.
 */

/**
 * Campos de `appendAgentStep` derivados do passo do runtime: a telemetria vai
 * para `outputJson.telemetry` (sem coluna nova) e o tempo/custo para as colunas
 * `durationMs`/`costUsd` já existentes.
 */
export function stepTelemetryFields(step: RuntimeStepRecord): {
	outputJson: unknown;
	durationMs?: number;
	costUsd?: number;
} {
	const base =
		step.outputJson && typeof step.outputJson === "object" && !Array.isArray(step.outputJson)
			? (step.outputJson as Record<string, unknown>)
			: undefined;
	const outputJson = step.telemetry
		? { ...(base ?? {}), telemetry: step.telemetry }
		: step.outputJson;
	return {
		outputJson,
		...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
		...(step.costUsd !== undefined ? { costUsd: step.costUsd } : {}),
	};
}

/** Setup (lease → 1a chamada ao modelo) e pós-conclusão (fim do runtime → gravação final). */
export function createRunTelemetryTracker(
	now: () => number = () => performance.now(),
) {
	let leaseAt = now();
	let setupMs: number | undefined;
	let runtimeDoneAt: number | undefined;
	let postMs: number | undefined;
	let requestedModel: string | undefined;
	let servedModel: string | undefined;

	return {
		markLeaseAcquired(): void {
			leaseAt = now();
			setupMs = undefined;
		},
		/** O 1o passo de modelo informa a duração: o início da chamada = agora - modelMs. */
		onStep(step: RuntimeStepRecord): void {
			if (step.type !== "model") return;
			// Último modelo servido do run (A7): a UI compara com o pedido.
			if (step.telemetry?.requestedModel) requestedModel ??= step.telemetry.requestedModel;
			if (step.telemetry?.servedModel) servedModel = step.telemetry.servedModel;
			if (setupMs !== undefined) return;
			const modelMs = step.telemetry?.modelMs ?? step.durationMs ?? 0;
			setupMs = Math.max(0, Math.round(now() - modelMs - leaseAt));
		},
		markRuntimeDone(): void {
			runtimeDoneAt = now();
		},
		/** Chamar logo antes da gravação final do run. */
		markBeforeFinalWrite(): void {
			if (runtimeDoneAt !== undefined) {
				postMs = Math.max(0, Math.round(now() - runtimeDoneAt));
			}
		},
		meta(jev?: JevTelemetry): RunTelemetryMeta {
			return {
				v: 1,
				...(setupMs !== undefined ? { setupMs } : {}),
				...(postMs !== undefined ? { postMs } : {}),
				...(requestedModel ? { requestedModel } : {}),
				...(servedModel ? { servedModel } : {}),
				...(jev ? { jev } : {}),
			};
		},
	};
}

/** Uso do run + metadados de telemetria (Jev fica em `telemetry.jev`, fora dos totais). */
export function withRunTelemetry(
	usage: RunUsage | undefined,
	meta: RunTelemetryMeta,
): RunUsage | undefined {
	return usage ? { ...usage, telemetry: meta } : usage;
}
