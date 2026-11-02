// Estado da tela do Computador: acha a sessão da VM do bot, pede o endereço do WebSocket e conduz a conexão do noVNC
// (na página da WebView) com reconexão automática (`computer-reconnect.ts`). O endereço, que leva o token, vive só neste
// estado do React: nunca em log, cache nem disco, e cada (re)conexão pede um novo.
import * as React from "react";
import type { ComputerStatus } from "@/components/computer/computer-view";
import { ComputerApiError, computerErrorText, getComputerSession, getViewerSocket, startComputer } from "./computer-api";
import { initialReconnect, msUntilRetry, reconnectStep, type ReconnectEvent, type ReconnectState } from "./computer-reconnect";
import type { ApiFetch } from "./home-sync";
import type { BridgeEvent } from "./viewer-bridge";
import { withTimeout } from "./with-timeout";

/** Computador ligando: confere de novo a cada 3 s, até ~1 min. */
const STARTING_POLL_MS = 3_000;
const STARTING_POLL_MAX = 20;
/** O pedido do link da tela também tem prazo: com a rede travada a tela não pode ficar em "Conectando" para sempre. */
const LINK_TIMEOUT_MS = 15_000;
/** A página tem este tempo para conectar depois de receber o endereço; senão conta como queda. */
const CONNECT_TIMEOUT_MS = 20_000;

export type UseComputer = {
	status: ComputerStatus;
	/** A WebView deve estar montada (sessão achada e conectando ou conectado). */
	mounted: boolean;
	/** `wss://…` com token, só para a WebView (por `injectJavaScript`), nunca para log. */
	socketUrl: string | null;
	/** Muda a cada endereço novo: força a página a reconectar. */
	socketKey: number;
	sessionId: string | null;
	/** Frase amigável do erro (status "error"). */
	error: string | null;
	/** Tentar de novo do começo. */
	retry: () => void;
	/** Liga o computador (status "off") e abre a tela. */
	start: () => void;
	/** Eventos da página (WebView). */
	onBridgeEvent: (event: BridgeEvent) => void;
};

const FATAL = new Set(["unauthorized", "not-found", "viewer-unavailable", "bad-link"]);

/**
 * `active` (ver `viewer-active.ts`): com a tela fora de foco ou o app em segundo plano o hook não faz NADA (sem sessão, sem
 * link, sem timers nem reconexão) e a WebView desmonta; ao voltar recomeça do zero.
 */
export function useComputer({ apiFetch, serverUrl, conversationId, active }: { apiFetch: ApiFetch; serverUrl: string | null; conversationId: string | null; active: boolean }): UseComputer {
	const [status, setStatus] = React.useState<ComputerStatus>("loading");
	const [socket, setSocket] = React.useState<{ url: string; key: number } | null>(null);
	const [sessionId, setSessionId] = React.useState<string | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	// `n` muda a cada "de novo"/"ligar"; `start` diz se esta rodada liga o computador antes de abrir.
	const [round, setRound] = React.useState({ n: 0, start: false });
	const apiRef = React.useRef({ apiFetch, serverUrl });
	apiRef.current = { apiFetch, serverUrl };
	const handler = React.useRef<((event: BridgeEvent) => void) | null>(null);

	React.useEffect(() => {
		if (!active) {
			// Fora de foco ou em segundo plano: tudo parado e a WebView some (sem sessão = sem WebView). Voltar recomeça do zero.
			setSocket(null);
			setSessionId(null);
			setError(null);
			setStatus("loading");
			return;
		}
		let alive = true;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let connectTimer: ReturnType<typeof setTimeout> | undefined;
		let keyCounter = 0;
		let machine: ReconnectState = initialReconnect;
		let failure: string | null = null;

		const off = () => {
			if (!alive) return;
			setSocket(null);
			setSessionId(null);
			setStatus("off");
		};
		const fail = (message: string) => {
			if (!alive) return;
			setSocket(null);
			setError(message);
			setStatus("error");
		};
		const render = (state: ReconnectState) => {
			if (state.phase === "connected") {
				setError(null);
				setStatus("ready");
			} else if (state.phase === "failed") {
				fail(failure ?? computerErrorText(new ComputerApiError("unavailable")));
			} else {
				setStatus("loading");
			}
		};
		const schedule = () => {
			clearTimeout(retryTimer);
			const ms = msUntilRetry(machine, Date.now());
			if (ms !== null) retryTimer = setTimeout(() => apply({ t: "tick" }), ms);
		};
		const apply = (event: ReconnectEvent) => {
			if (!alive) return;
			const out = reconnectStep(machine, event, Date.now());
			machine = out.state;
			if (event.t === "connected" || event.t === "dropped" || event.t === "fatal") clearTimeout(connectTimer);
			render(machine);
			schedule();
			if (out.action === "connect") void connect();
		};
		// Pede o endereço novo (cada conexão tem o seu token) e entrega à página.
		const connect = async () => {
			const id = sessionRef;
			const { apiFetch: api, serverUrl: base } = apiRef.current;
			if (!id || !base) return apply({ t: "fatal" });
			try {
				const url = await withTimeout(getViewerSocket(api, base, id), LINK_TIMEOUT_MS, () => new ComputerApiError("network"));
				if (!alive) return;
				setSocket({ url, key: ++keyCounter });
				clearTimeout(connectTimer);
				connectTimer = setTimeout(() => apply({ t: "dropped" }), CONNECT_TIMEOUT_MS);
			} catch (reason) {
				if (!alive) return;
				if (reason instanceof ComputerApiError && FATAL.has(reason.kind)) {
					failure = computerErrorText(reason);
					apply({ t: "fatal" });
				} else {
					apply({ t: "dropped" });
				}
			}
		};
		let sessionRef: string | null = null;

		handler.current = (event) => {
			switch (event.t) {
				case "connected":
					return apply({ t: "connected" });
				case "disconnected":
				case "error":
					return apply({ t: "dropped" });
				case "securityfailure":
				case "credentialsrequired":
					failure = computerErrorText(new ComputerApiError("unavailable"));
					return apply({ t: "fatal" });
				case "ready":
					return;
			}
		};

		const load = async (startFirst: boolean) => {
			setStatus("loading");
			setError(null);
			if (!conversationId) return off();
			try {
				const { apiFetch: api } = apiRef.current;
				let session = startFirst ? await startComputer(api, conversationId) : await getComputerSession(api, conversationId);
				for (let polls = 0; alive && session && session.status === "starting"; polls++) {
					if (polls >= STARTING_POLL_MAX) throw new ComputerApiError("unavailable");
					await new Promise((resolve) => setTimeout(resolve, STARTING_POLL_MS));
					if (!alive) return;
					session = await getComputerSession(api, conversationId);
				}
				if (!alive) return;
				if (!session || session.status === "stopped") return off();
				if (session.status === "error") throw new ComputerApiError("unavailable");
				sessionRef = session.sessionId;
				setSessionId(session.sessionId);
				machine = initialReconnect;
				apply({ t: "start" });
			} catch (reason) {
				fail(computerErrorText(reason));
			}
		};
		void load(round.start);
		return () => {
			alive = false;
			clearTimeout(retryTimer);
			clearTimeout(connectTimer);
			handler.current = null;
		};
	}, [conversationId, round, active]);

	const retry = React.useCallback(() => setRound((r) => ({ n: r.n + 1, start: false })), []);
	const start = React.useCallback(() => setRound((r) => ({ n: r.n + 1, start: true })), []);
	const onBridgeEvent = React.useCallback((event: BridgeEvent) => handler.current?.(event), []);

	return { status, mounted: sessionId !== null && (status === "loading" || status === "ready"), socketUrl: socket?.url ?? null, socketKey: socket?.key ?? 0, sessionId, error, retry, start, onBridgeEvent };
}
