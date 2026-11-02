// Estado da conferência com o servidor ("Verificando novas mensagens…"): o chat abre com o cache e, enquanto a
// rede responde, aparece uma linha discreta acima do composer. Reducer puro; a tela só lê `statusLine`.
export type SyncPhase = "idle" | "checking" | "offline";
export type SyncState = { phase: SyncPhase; /** Quantas conferências estão em voo (puxar, voltar do segundo plano, abrir). */ inFlight: number };
export type SyncAction = { type: "start" } | { type: "success" } | { type: "network-failure" } | { type: "failure" } | { type: "reset" };

export const initialSync: SyncState = { phase: "idle", inFlight: 0 };

export function syncReducer(state: SyncState, action: SyncAction): SyncState {
	switch (action.type) {
		case "start":
			return { phase: "checking", inFlight: state.inFlight + 1 };
		case "success": {
			const inFlight = Math.max(0, state.inFlight - 1);
			return { phase: inFlight > 0 ? "checking" : "idle", inFlight };
		}
		case "network-failure": {
			const inFlight = Math.max(0, state.inFlight - 1);
			return { phase: inFlight > 0 ? "checking" : "offline", inFlight };
		}
		case "failure": {
			// Erro do servidor (não de rede): some sem alarde; as mensagens carregadas seguem na tela.
			const inFlight = Math.max(0, state.inFlight - 1);
			return { phase: inFlight > 0 ? "checking" : "idle", inFlight };
		}
		case "reset":
			return initialSync;
	}
}

/** Linha acima do composer: bolinhas + "Verificando novas mensagens…" enquanto confere; "Sem conexão" discreto se a rede falhou. */
export function syncLine(state: SyncState): { kind: "checking"; text: string } | { kind: "offline"; text: string } | null {
	if (state.phase === "checking") return { kind: "checking", text: "Verificando novas mensagens…" };
	if (state.phase === "offline") return { kind: "offline", text: "Sem conexão" };
	return null;
}
