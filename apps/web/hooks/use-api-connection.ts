"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiConnectionView, ApiProposal } from "@workspace/shared";
import {
	createApiConnection,
	deleteApiConnection,
	listApiConnections,
	openMcpOAuthPopup,
	reauthApiConnection,
	updateApiConnection,
	waitMcpOAuthPopup,
	type ApiConnectionStartResult,
} from "@/lib/atlas-api";
import { pollMcpOAuthConnection } from "@/lib/mcp-oauth-wait";

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Espera o login de uma conexão de API terminar olhando o status recarregado
 * (no celular o popup vira aba externa e o `postMessage` não é confiável),
 * com o mesmo polling do Marketplace.
 */
async function waitConnected(started: ApiConnectionStartResult, popup: Window | null): Promise<{ ok: boolean; error?: string }> {
	const load = async () => (await listApiConnections()).find((item) => item.id === started.connection.id);
	if (!started.authorizeUrl) {
		const fresh = await load();
		return fresh?.status === "connected" ? { ok: true } : { ok: false, error: fresh?.lastError ?? "Conexão não concluída." };
	}
	const result = await pollMcpOAuthConnection({ popup: waitMcpOAuthPopup(popup, started.authorizeUrl), load });
	popup?.close();
	if (!result.ok) return { ok: false, error: result.error };
	const fresh = await load();
	return fresh?.status === "connected" ? { ok: true } : { ok: false, error: fresh?.lastError ?? "Login não concluído." };
}

export type ApiConnectForm = { clientId?: string; clientSecret?: string; apiKey?: string; allowedTags: string[] };

/**
 * Card "Conectar API" no chat: as credenciais digitadas vão direto para a
 * API do servidor (cofre); este hook nunca as guarda além da chamada. O sucesso
 * é o status recarregado da conexão, nunca o popup.
 */
export function useApiConnect(proposal: ApiProposal, enabled: boolean, options: { newAccount?: boolean } = {}) {
	const newAccount = options.newAccount === true;
	const [existing, setExisting] = useState<ApiConnectionView | null>(null);
	const [justConnected, setJustConnected] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const busyRef = useRef(false);
	const connectedRef = useRef(false);

	useEffect(() => {
		if (!enabled) return;
		let alive = true;
		const load = (initial: boolean) =>
			listApiConnections()
				.then((items) => {
					if (!alive) return;
					const found = items.find((item) => item.baseUrl === proposal.baseUrl) ?? null;
					const now = found?.status === "connected";
					// Conectou por fora do card (outra aba/Conectores): o card acompanha e retoma o run.
					if (now && !connectedRef.current && !initial) setJustConnected(true);
					connectedRef.current = now;
					setExisting(found);
				})
				.catch(() => undefined);
		void load(true);
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
	}, [enabled, proposal.baseUrl]);

	const connect = useCallback(
		async (form: ApiConnectForm) => {
			if (busyRef.current) return;
			busyRef.current = true;
			// O popup abre no clique (antes de qualquer await) para o navegador não bloquear.
			const popup = proposal.authKind === "oauth2" ? openMcpOAuthPopup() : null;
			setBusy(true);
			setError(null);
			try {
				const started = await createApiConnection({
					specUrl: proposal.specUrl,
					allowedTags: form.allowedTags,
					...(form.clientId ? { clientId: form.clientId } : {}),
					...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
					...(form.apiKey ? { apiKey: form.apiKey } : {}),
					...(newAccount ? { newAccount: true } : {}),
				});
				setExisting(started.connection);
				const outcome = await waitConnected(started, popup);
				if (outcome.ok) {
					connectedRef.current = true;
					setJustConnected(true);
					setExisting({ ...started.connection, status: "connected", lastError: null });
				} else setError(outcome.error ?? "Não foi possível conectar.");
			} catch (cause) {
				popup?.close();
				setError(messageOf(cause, "Não foi possível conectar."));
			} finally {
				busyRef.current = false;
				setBusy(false);
			}
		},
		[proposal.authKind, proposal.specUrl, newAccount],
	);

	return { existing, connected: existing?.status === "connected", justConnected, busy, error, connect };
}

/** Lista de APIs conectadas (Conectores): reconectar, desconectar e editar os grupos de acesso. */
export function useApiConnections(enabled: boolean) {
	const [items, setItems] = useState<ApiConnectionView[] | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			setItems(await listApiConnections());
		} catch (cause) {
			setError(messageOf(cause, "Não foi possível carregar as APIs."));
		}
	}, []);

	useEffect(() => {
		if (enabled) void reload();
	}, [enabled, reload]);

	const run = useCallback(
		async (id: string, action: () => Promise<void>): Promise<boolean> => {
			setBusyId(id);
			setError(null);
			try {
				await action();
				await reload();
				return true;
			} catch (cause) {
				setError(messageOf(cause, "Não foi possível concluir."));
				return false;
			} finally {
				setBusyId(null);
			}
		},
		[reload],
	);

	const reconnect = useCallback(
		(item: ApiConnectionView, input: { apiKey?: string } = {}) => {
			// OAuth abre o popup no clique; chave/token reaproveitam o mesmo endpoint com a chave nova.
			const popup = item.authKind === "oauth2" ? openMcpOAuthPopup() : null;
			return run(item.id, async () => {
				try {
					const started = await reauthApiConnection(item.id, input);
					const outcome = await waitConnected(started, popup);
					if (!outcome.ok) throw new Error(outcome.error ?? "Não foi possível conectar.");
				} catch (cause) {
					popup?.close();
					throw cause;
				}
			});
		},
		[run],
	);

	return {
		items,
		busyId,
		error,
		reload,
		reconnect,
		remove: (id: string) => run(id, () => deleteApiConnection(id)),
		rename: (id: string, label: string) => run(id, async () => void (await updateApiConnection(id, { accountLabel: label || null }))),
		saveGroups: (id: string, allowedTags: string[]) => run(id, async () => void (await updateApiConnection(id, { allowedTags }))),
	};
}
