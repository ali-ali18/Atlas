// Cópia de feat/mobile-aplicativos (mesmo conteúdo): unificar quando as duas branches entrarem na main.
// Conectar um aplicativo pelo navegador: abre o login do provedor e fica conferindo (a cada 1 s, até 90 s) se a conexão
// ficou ativa. Navegador fechado sem conectar = a pessoa desistiu: para sem erro. Relógio e espera são injetados.
import { type AppStateSource, createBrowserCloseTracker, NEVER_CHANGES, RETURN_GRACE_MS } from "./browser-return";

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

/** `cancelled`: a tela saiu enquanto esperava (nada é fechado nem atualizado: o fluxo pode já ser outro). */
export type ConnectOutcome = "connected" | "closed" | "timeout" | "cancelled";

export type ConnectFlowDeps = {
	/** Abre o navegador. iOS resolve ao fechar; Android resolve ao abrir (`type: "opened"`): ver `browser-return.ts`. */
	open: (url: string) => Promise<{ type?: unknown } | null | undefined | void>;
	/** AppState (injetado): no Android é ele que avisa que o navegador fechou. Assinado antes de abrir. */
	appState?: AppStateSource;
	/** Fecha o navegador (depois de conectar). */
	dismiss: () => void;
	/** Lê o servidor: a conexão já está ativa? Falha de rede conta como "ainda não", salvo `isFatal`. */
	check: () => Promise<boolean>;
	/** Erro que não adianta tentar de novo (sessão expirada): sobe em vez de virar "ainda não". */
	isFatal?: (error: unknown) => boolean;
	/** Cancelamento (a tela saiu). */
	signal?: { aborted: boolean };
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	intervalMs?: number;
	timeoutMs?: number;
	/** Janela de graça depois que o app volta ao primeiro plano (Android). */
	returnGraceMs?: number;
};

export async function runBrowserConnect(url: string, deps: ConnectFlowDeps): Promise<ConnectOutcome> {
	const tracker = createBrowserCloseTracker(deps.appState ?? NEVER_CHANGES, deps.now, deps.returnGraceMs ?? RETURN_GRACE_MS);
	const startedAt = deps.now();
	void deps.open(url).then(
		(result) => tracker.settle(result ?? null),
		() => tracker.settle(null),
	);
	try {
		for (;;) {
			await deps.sleep(deps.intervalMs ?? POLL_INTERVAL_MS);
			if (deps.signal?.aborted) return "cancelled";
			// Lê "fechou" antes da conferência: se fechou, esta é a conferência final (o servidor pode ter acabado de receber o login).
			const browserClosed = tracker.closed();
			let connected = false;
			try {
				connected = await deps.check();
			} catch (error) {
				if (deps.isFatal?.(error)) throw error;
			}
			if (deps.signal?.aborted) return "cancelled";
			const decision = decidePoll({ connected, browserClosed, startedAt, now: deps.now(), timeoutMs: deps.timeoutMs });
			if (decision === "continue") continue;
			if (decision === "connected") deps.dismiss();
			return decision;
		}
	} finally {
		tracker.dispose();
	}
}
