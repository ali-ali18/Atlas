// Conectar um aplicativo pelo navegador: abre o login do provedor e fica conferindo (a cada 1 s, até 90 s) se a conexão
// ficou ativa. Navegador fechado sem conectar = a pessoa desistiu: para sem erro. Relógio e espera são injetados.

export const POLL_INTERVAL_MS = 1000;
export const POLL_TIMEOUT_MS = 90_000;

export type PollDecision = "connected" | "closed" | "timeout" | "continue";

/** Conectado ganha de tudo (a conferência final depois de fechar o navegador ainda conta); depois vem fechado, depois o tempo. */
export function decidePoll(input: { connected: boolean; browserClosed: boolean; startedAt: number; now: number; timeoutMs?: number }): PollDecision {
	if (input.connected) return "connected";
	if (input.browserClosed) return "closed";
	if (input.now - input.startedAt >= (input.timeoutMs ?? POLL_TIMEOUT_MS)) return "timeout";
	return "continue";
}

export type ConnectOutcome = "connected" | "closed" | "timeout";

export type ConnectFlowDeps = {
	/** Abre o navegador; resolve quando ele fecha. */
	open: (url: string) => Promise<unknown>;
	/** Fecha o navegador (depois de conectar). */
	dismiss: () => void;
	/** Lê o servidor: a conexão já está ativa? Falha de rede conta como "ainda não". */
	check: () => Promise<boolean>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	intervalMs?: number;
	timeoutMs?: number;
};

export async function runBrowserConnect(url: string, deps: ConnectFlowDeps): Promise<ConnectOutcome> {
	let closed = false;
	const startedAt = deps.now();
	void deps.open(url).then(
		() => {
			closed = true;
		},
		() => {
			closed = true;
		},
	);
	for (;;) {
		await deps.sleep(deps.intervalMs ?? POLL_INTERVAL_MS);
		// Lê "fechou" antes da conferência: se fechou, esta é a conferência final (o servidor pode ter acabado de receber o login).
		const browserClosed = closed;
		const connected = await deps.check().catch(() => false);
		const decision = decidePoll({ connected, browserClosed, startedAt, now: deps.now(), timeoutMs: deps.timeoutMs });
		if (decision === "continue") continue;
		if (decision === "connected") deps.dismiss();
		return decision;
	}
}
