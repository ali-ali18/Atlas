import type { JevTelemetry, LateRunUsage, RunTelemetryMeta } from "@workspace/shared";

/**
 * Checagens que só observam a resposta final terminam depois da conclusão do run (ver
 * `backgroundObserveChecks` no runtime). Quando terminam, o uso delas entra no `usageJson` do run e,
 * se o Jev decidiu algo depois da conclusão, a telemetria é regravada. Nunca rejeita.
 */
export async function recordObserveChecks(
	input: {
		runId: string;
		userId: string;
		observeChecks: Promise<LateRunUsage | null> | undefined;
		/** `jev.calls` gravado na conclusão. */
		jevCallsAtCompletion: number;
		jevSnapshot: () => JevTelemetry | undefined;
		/** Metadados de telemetria com o Jev atual (o resto não muda depois da conclusão). */
		meta: (jev: JevTelemetry | undefined) => RunTelemetryMeta;
		/** A conclusão gravou `usageJson` (sem ele não há onde pôr a telemetria). */
		hasUsage: boolean;
	},
	deps: {
		addLateRunUsage: (input: { runId: string; userId: string; usage: LateRunUsage | null; telemetry?: RunTelemetryMeta }) => Promise<boolean>;
		log?: (message: string, error: unknown) => void;
	},
): Promise<void> {
	if (!input.observeChecks) return;
	try {
		const usage = await input.observeChecks;
		const jev = input.jevSnapshot();
		const jevChanged = (jev?.calls ?? 0) !== input.jevCallsAtCompletion;
		if (!usage && !jevChanged) return;
		await deps.addLateRunUsage({
			runId: input.runId,
			userId: input.userId,
			usage,
			...(jevChanged && input.hasUsage ? { telemetry: input.meta(jev) } : {}),
		});
	} catch (error) {
		(deps.log ?? ((message, cause) => console.error(message, cause)))(`[run] uso das checagens finais não gravado run=${input.runId}`, error);
	}
}
