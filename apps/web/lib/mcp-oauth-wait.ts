export type McpOAuthPopupOutcome = { ok: boolean; error?: string; closed?: boolean };
import { activeT } from "@/lib/i18n/active";
export type McpOAuthWaitResult = { ok: boolean; error?: string; cancelled?: boolean };

type LoadedConnection = { status: string; lastError?: string | null } | undefined | null;

export type PollMcpOAuthOptions = {
	/** Termina quando o popup manda a mensagem ou fecha (no celular pode fechar/perder o opener cedo). */
	popup: Promise<McpOAuthPopupOutcome>;
	/** Recarrega o estado atual da conexão. */
	load: () => Promise<LoadedConnection>;
	timeoutMs?: number;
	intervalMs?: number;
	signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_INTERVAL_MS = 1_000;

/** Dorme até o intervalo passar ou a aba voltar a ficar visível/focada (o que vier primeiro). */
function nap(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const hasDoc = typeof document !== "undefined" && typeof window !== "undefined";
		const timer = setTimeout(done, ms);
		function onVisible() {
			if (document.visibilityState === "visible") done();
		}
		function done() {
			clearTimeout(timer);
			if (hasDoc) {
				document.removeEventListener("visibilitychange", onVisible);
				window.removeEventListener("focus", done);
			}
			signal?.removeEventListener("abort", done);
			resolve();
		}
		if (hasDoc) {
			document.addEventListener("visibilitychange", onVisible);
			window.addEventListener("focus", done);
		}
		signal?.addEventListener("abort", done);
	});
}

/**
 * Espera o login OAuth terminar olhando o status da conexão, não o popup:
 * no celular/PWA o popup vira aba externa e `closed`/`postMessage` não são
 * confiáveis. Só falha de verdade quando o callback avisa o erro, o tempo
 * esgota ou o usuário cancela.
 */
export async function pollMcpOAuthConnection(options: PollMcpOAuthOptions): Promise<McpOAuthWaitResult> {
	const { popup, load, signal } = options;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;
	let outcome: McpOAuthPopupOutcome | null = null;
	void popup.then((value) => {
		outcome = value;
	});
	let last: LoadedConnection;
	for (;;) {
		if (signal?.aborted) return { ok: false, cancelled: true };
		try {
			last = await load();
		} catch {
			// falha de rede passageira: tenta de novo até o prazo.
		}
		if (signal?.aborted) return { ok: false, cancelled: true };
		if (last?.status === "connected") return { ok: true };
		const known = outcome as McpOAuthPopupOutcome | null;
		// Erro explícito vindo da página de callback é terminal.
		if (known && !known.closed && !known.ok) {
			return { ok: false, error: last?.lastError ?? known.error ?? activeT("errors.loginIncomplete") };
		}
		if (Date.now() >= deadline) {
			return { ok: false, error: last?.lastError ?? known?.error ?? activeT("errors.loginIncomplete") };
		}
		await nap(intervalMs, signal);
	}
}
