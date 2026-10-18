"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	getMcpCatalog,
	listMcpConnections,
	openMcpOAuthPopup,
	startMcpOAuth,
	waitMcpOAuthPopup,
	type McpCatalogItem,
} from "@/lib/atlas-api";
import { pollMcpOAuthConnection } from "@/lib/mcp-oauth-wait";

/** Ação do botão do card: login de um clique ou, quando falta app OAuth/chave, o Marketplace. */
export function nativeConnectorAction(entry: McpCatalogItem | null): "connect" | "marketplace" | "loading" {
	if (!entry) return "loading";
	// Login de um clique sempre que o conector usa OAuth (se faltar o app OAuth no servidor, o erro
	// real aparece no card). Marketplace só para o que exige cadastro manual, como chave de API.
	if (entry.authType === "oauth" && (entry.oauthReady || !entry.apiKey)) return "connect";
	return "marketplace";
}

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Conecta ou reconecta um conector do Marketplace de dentro do chat, com o
 * mesmo popup OAuth do Marketplace. Só o status recarregado decide o sucesso.
 */
export function useNativeConnector(catalogId: string, enabled: boolean) {
	const [entry, setEntry] = useState<McpCatalogItem | null>(null);
	const [connected, setConnected] = useState(false);
	const [justConnected, setJustConnected] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const busyRef = useRef(false);
	const connectedRef = useRef(false);

	useEffect(() => {
		if (!enabled) return;
		let alive = true;
		const load = (initial: boolean) =>
			getMcpCatalog()
				.then(({ entries }) => {
					if (!alive) return;
					const found = entries.find((item) => item.id === catalogId) ?? null;
					setEntry(found);
					const nowConnected = found?.status === "connected";
					// Conectou por fora do card (Marketplace em outra aba): o card acompanha e retoma o run.
					if (nowConnected && !connectedRef.current && !initial) setJustConnected(true);
					connectedRef.current = nowConnected;
					setConnected(nowConnected);
				})
				.catch((cause) => {
					if (alive && initial) setError(messageOf(cause, "Não foi possível carregar o conector."));
				});
		void load(true);
		// Ao voltar para a aba (depois de conectar no Marketplace), recarrega o estado.
		const refresh = () => {
			if (document.visibilityState === "visible" && !busyRef.current && !connectedRef.current) void load(false);
		};
		document.addEventListener("visibilitychange", refresh);
		window.addEventListener("focus", refresh);
		return () => {
			alive = false;
			document.removeEventListener("visibilitychange", refresh);
			window.removeEventListener("focus", refresh);
		};
	}, [enabled, catalogId]);

	const connect = useCallback(async () => {
		if (busyRef.current || !entry) return;
		busyRef.current = true;
		// O popup abre no clique (antes de qualquer await) para o navegador não bloquear.
		const popup = openMcpOAuthPopup();
		setBusy(true);
		setError(null);
		try {
			// Mesmo caminho do Marketplace: o servidor reaproveita a conexão existente do dono.
			const started = await startMcpOAuth({ catalogId: entry.id });
			const load = async () => (await listMcpConnections()).find((item) => item.id === started.connection.id);
			let fresh = started.authorizeUrl ? undefined : await load();
			let failure: string | undefined;
			if (started.authorizeUrl) {
				const result = await pollMcpOAuthConnection({ popup: waitMcpOAuthPopup(popup, started.authorizeUrl), load });
				popup?.close();
				failure = result.error;
				if (result.ok) fresh = await load();
			} else popup?.close();
			if (fresh?.status === "connected") {
				connectedRef.current = true;
				setConnected(true);
				setJustConnected(true);
			} else {
				setError(fresh?.lastError ?? failure ?? "Login não concluído.");
			}
		} catch (cause) {
			popup?.close();
			setError(messageOf(cause, "Não foi possível iniciar o login."));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}, [entry]);

	return { entry, connected, justConnected, busy, error, connect };
}
