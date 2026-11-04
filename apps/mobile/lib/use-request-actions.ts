// As ações dos cartões de pedido (conectar app, login, segredo) ligadas à sessão do app: cada uma devolve só o
// desfecho em palavras simples. Credencial e segredo entram como argumento, vão direto à API e não ficam em lugar nenhum.
// Falha de sessão (401) encerra a sessão, como no resto do app.
import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { AppState } from "react-native";
import type { LoginConnector } from "@workspace/shared";
import * as chatApi from "./chat-api";
import { allowsHttp, connectErrorText, isConnectorConnected, startConnectorConnect } from "./connector-connect";
import { runBrowserConnect } from "./connect-flow";
import { useAtlasSession } from "./atlas-session";
import type { LoginItem } from "./request-cards";
import { vaultErrorText, vaultLoginBody } from "./request-cards";

export type ActionResult = { ok: true } | { ok: false; error: string };
export type ConnectResultView = { outcome: "connected" | "closed" | "timeout" | "cancelled" } | { error: string };

export type RequestActions = {
	connectApp: (connector: LoginConnector, signal: { aborted: boolean }) => Promise<ConnectResultView>;
	saveSecrets: (entries: { name: string; value: string }[]) => Promise<ActionResult>;
	saveLogin: (item: Pick<LoginItem, "url" | "site">, username: string, password: string) => Promise<ActionResult>;
};

export function useRequestActions(): RequestActions {
	const { apiFetch, serverUrl, signOut } = useAtlasSession();
	const latest = React.useRef({ apiFetch, serverUrl, signOut });
	latest.current = { apiFetch, serverUrl, signOut };

	return React.useMemo<RequestActions>(() => {
		const failed = (error: unknown, text: (status: number | null) => string): { ok: false; error: string } => {
			if (chatApi.isUnauthorized(error)) void latest.current.signOut();
			return { ok: false, error: text(error instanceof chatApi.ChatApiError ? error.status : null) };
		};
		return {
			async connectApp(connector, signal) {
				const { apiFetch: fetchApi, serverUrl: server } = latest.current;
				try {
					const started = await startConnectorConnect(fetchApi, connector, allowsHttp(server));
					if (started.kind === "connected") return { outcome: "connected" };
					const outcome = await runBrowserConnect(started.url, {
						open: (url) => WebBrowser.openBrowserAsync(url),
						appState: {
							subscribe: (listener) => {
								const subscription = AppState.addEventListener("change", listener);
								return () => subscription.remove();
							},
						},
						dismiss: () => WebBrowser.dismissBrowser(),
						check: () => isConnectorConnected(latest.current.apiFetch, connector),
						isFatal: chatApi.isUnauthorized,
						signal,
						now: Date.now,
						sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
					});
					return { outcome };
				} catch (error) {
					if (chatApi.isUnauthorized(error)) void latest.current.signOut();
					return { error: connectErrorText(error) };
				}
			},
			async saveSecrets(entries) {
				try {
					await chatApi.saveVaultSecrets(latest.current.apiFetch, entries);
					return { ok: true };
				} catch (error) {
					return failed(error, vaultErrorText);
				}
			},
			async saveLogin(item, username, password) {
				try {
					await chatApi.saveVaultLogin(latest.current.apiFetch, vaultLoginBody(item, username, password));
					return { ok: true };
				} catch (error) {
					return failed(error, vaultErrorText);
				}
			},
		};
	}, []);
}
