// Conectar o app do cartão pelo navegador, fora do ciclo de vida do cartão: quem chama é o controller do chat, que vive
// enquanto o chat está aberto (a linha da lista desmonta ao rolar, o fluxo não). Tudo entra por injeção.
import type { LoginConnector } from "@workspace/shared";
import type { AppStateSource } from "./browser-return";
import { isUnauthorized } from "./chat-api";
import { type ConnectOutcome, runBrowserConnect } from "./connect-flow";
import { allowsHttp, connectErrorText, isConnectorConnected, startConnectorConnect } from "./connector-connect";
import type { ApiFetch } from "./home-sync";

export type ConnectResultView = { outcome: ConnectOutcome } | { error: string };

export type ConnectAppDeps = {
	apiFetch: ApiFetch;
	serverUrl: string | null;
	open: (url: string) => Promise<{ type?: unknown } | null | undefined | void>;
	dismiss: () => void;
	appState: AppStateSource;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	/** 401: encerra a sessão. */
	onUnauthorized: () => void;
};

export async function connectApp(deps: ConnectAppDeps, connector: LoginConnector, signal: { aborted: boolean }): Promise<ConnectResultView> {
	try {
		const started = await startConnectorConnect(deps.apiFetch, connector, allowsHttp(deps.serverUrl));
		if (started.kind === "connected") return { outcome: "connected" };
		const outcome = await runBrowserConnect(started.url, {
			open: deps.open,
			appState: deps.appState,
			dismiss: deps.dismiss,
			check: () => isConnectorConnected(deps.apiFetch, connector),
			isFatal: isUnauthorized,
			signal,
			now: deps.now,
			sleep: deps.sleep,
		});
		// A tela saiu no meio: o navegador do login não fica aberto sem ninguém esperando.
		if (outcome === "cancelled") deps.dismiss();
		return { outcome };
	} catch (error) {
		if (isUnauthorized(error)) deps.onUnauthorized();
		return { error: connectErrorText(error) };
	}
}
