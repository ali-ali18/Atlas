// As ações dos cartões de pedido (conectar app, login, segredo) ligadas à sessão do app: cada uma devolve só o
// desfecho em palavras simples. Credencial e segredo entram como argumento, vão direto à API e não ficam em lugar nenhum.
// Falha de sessão (401) encerra a sessão, como no resto do app.
import * as React from "react";
import * as chatApi from "./chat-api";
import { useAtlasSession } from "./atlas-session";
import type { LoginItem } from "./request-cards";
import { vaultErrorText, vaultLoginBody } from "./request-cards";

export type ActionResult = { ok: true } | { ok: false; error: string };

export type RequestActions = {
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
