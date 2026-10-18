/**
 * Leitura única de cancelamento/pausa do run (L10). O loop do agente consulta os
 * dois várias vezes por decisão (início do passo, antes do modelo, antes de cada
 * tool); sem isto cada consulta era uma ida ao banco. Leituras próximas
 * compartilham o resultado (janela curta) e leituras simultâneas compartilham a
 * mesma consulta em andamento. O fence de `appendAgentStep` continua conferindo
 * o cancelamento a cada gravação, então o atraso máximo é a janela.
 */
export type RunControlState = { cancelRequested: boolean; pauseRequested: boolean };

export function createRunControlReader(input: {
	read: () => Promise<RunControlState>;
	/** Janela em que o último resultado ainda vale. */
	freshMs?: number;
	now?: () => number;
}): { get: () => Promise<RunControlState> } {
	const freshMs = input.freshMs ?? 750;
	const now = input.now ?? Date.now;
	let cached: { at: number; state: RunControlState } | null = null;
	let inflight: Promise<RunControlState> | null = null;
	return {
		get: async () => {
			if (cached && now() - cached.at < freshMs) return cached.state;
			if (!inflight) {
				inflight = input
					.read()
					.then((state) => {
						cached = { at: now(), state };
						return state;
					})
					.finally(() => {
						inflight = null;
					});
			}
			return inflight;
		},
	};
}
