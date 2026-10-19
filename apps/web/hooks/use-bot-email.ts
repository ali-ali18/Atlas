"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	AtlasApiError,
	disableBotEmail,
	enableBotEmail,
	getBotEmail,
	updateBotEmail,
	type BotEmailPayload,
} from "@/lib/atlas-api";

function messageOf(cause: unknown, fallback: string): string {
	return cause instanceof AtlasApiError && cause.message ? cause.message : fallback;
}

/**
 * Aba E-mail do bot: estado da conta (chave do provedor), caixa do bot e últimas mensagens, com ativar,
 * editar permitidos/limite/liga-desliga e remover. Recarrega ao abrir a aba e depois de cada ação.
 */
export function useBotEmail(botId: string, active: boolean) {
	const [data, setData] = useState<BotEmailPayload | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const request = useRef(0);

	const refresh = useCallback(async () => {
		const id = ++request.current;
		try {
			const next = await getBotEmail(botId);
			if (id !== request.current) return;
			setData(next);
			setLoadError(null);
		} catch (cause) {
			if (id !== request.current) return;
			setLoadError(messageOf(cause, "Não foi possível carregar o e-mail do bot."));
		} finally {
			if (id === request.current) setLoading(false);
		}
	}, [botId]);

	useEffect(() => {
		setData(null);
		setLoading(true);
		setActionError(null);
	}, [botId]);

	useEffect(() => {
		if (active) void refresh();
	}, [active, refresh]);

	/** Roda uma ação; devolve `true` se deu certo. O erro vira texto da aba (nunca o corpo cru). */
	const act = useCallback(async (action: () => Promise<BotEmailPayload>, fallback: string): Promise<boolean> => {
		setBusy(true);
		setActionError(null);
		try {
			request.current += 1;
			setData(await action());
			return true;
		} catch (cause) {
			setActionError(messageOf(cause, fallback));
			return false;
		} finally {
			setBusy(false);
		}
	}, []);

	return {
		data,
		loading,
		loadError,
		actionError,
		busy,
		refresh,
		enable: (domain?: string) => act(() => enableBotEmail(botId, domain), "Não foi possível ativar o endereço. Tente novamente."),
		patch: (patch: { allowedSenders?: string[]; dailySendLimit?: number; enabled?: boolean }) =>
			act(() => updateBotEmail(botId, patch), "Não foi possível salvar. Tente novamente."),
		remove: () => act(() => disableBotEmail(botId), "Não foi possível remover o endereço. Tente novamente."),
	};
}
