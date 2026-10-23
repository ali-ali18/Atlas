import { createRunSignals, redisFactories, type RunSignals, type SweepSignalKind } from "./run-signals.js";

/**
 * "Tem trabalho para a varredura X": a API cria turnos de grupo e mensagens entre bots, mas quem varre é o
 * worker (o gancho em processo do db só vale no mesmo processo). O aviso acorda a varredura do worker na hora,
 * e a consulta periódica dela fica só de segurança. Sem dado no aviso; perdido (Redis caiu) = a consulta cobre.
 */
export const SWEEP_SIGNAL_CHANNEL = "atlas:sweeps";
const SWEEP_KINDS: ReadonlySet<string> = new Set<SweepSignalKind>(["groups", "bot-messages"]);

export function createSweepSignals(deps: Parameters<typeof createRunSignals>[0]): {
	publish: (kind: SweepSignalKind) => Promise<boolean>;
	subscribe: (onSignal: (kind: SweepSignalKind) => void) => () => void;
	close: () => Promise<void>;
} {
	const signals: RunSignals = createRunSignals({ ...deps, channel: () => SWEEP_SIGNAL_CHANNEL, kinds: SWEEP_KINDS });
	return {
		publish: (kind) => signals.publishRunSignal("sweeps", kind),
		subscribe: (onSignal) =>
			signals.subscribeRunSignals("sweeps", (kind) => {
				if (SWEEP_KINDS.has(kind)) onSignal(kind as SweepSignalKind);
			}),
		close: () => signals.close(),
	};
}

let defaultSweepSignals: ReturnType<typeof createSweepSignals> | null = null;

function getDefaultSweepSignals() {
	defaultSweepSignals ??= createSweepSignals(redisFactories());
	return defaultSweepSignals;
}

/** API: avisa o worker que há turno de grupo ou mensagem entre bots nova. Melhor esforço, nunca lança. */
export function publishSweepSignal(kind: SweepSignalKind): Promise<boolean> {
	return getDefaultSweepSignals().publish(kind);
}

/** Worker: acorda a varredura certa ao receber o aviso. Devolve o unsubscribe. */
export function subscribeSweepSignals(onSignal: (kind: SweepSignalKind) => void): () => void {
	return getDefaultSweepSignals().subscribe(onSignal);
}

export async function closeSweepSignals(): Promise<void> {
	const current = defaultSweepSignals;
	defaultSweepSignals = null;
	await current?.close();
}
