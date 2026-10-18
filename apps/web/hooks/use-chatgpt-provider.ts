"use client";
import { useCallback, useEffect, useState } from "react";
import type { ProviderModel, ProviderStatus } from "@workspace/shared";
import { AtlasApiError, listChatgptModels, listProviders } from "@/lib/atlas-api";

export type ChatgptProviderView = {
	available: boolean;
	loading: boolean;
	status: ProviderStatus | null;
	models: ProviderModel[];
	catalogAvailable: boolean;
	error: string | null;
};
const initial: ChatgptProviderView = { available: false, loading: true, status: null, models: [], catalogAvailable: false, error: null };

/** Sem cache global: catálogo da assinatura e e-mail pertencem à sessão atual. */
/** `enabled=false` não consulta nada (plano desligado: a API responderia 404). */
export function useChatgptProvider(selected?: string, catalog = true, enabled = true) {
	const [state, setState] = useState<ChatgptProviderView>(initial);
	const [version, setVersion] = useState(0);
	const reload = useCallback(() => setVersion((value) => value + 1), []);
	useEffect(() => {
		const onChanged = () => reload();
		window.addEventListener("atlas:providers-changed", onChanged);
		window.addEventListener("focus", onChanged);
 return () => { window.removeEventListener("atlas:providers-changed", onChanged); window.removeEventListener("focus", onChanged); };
	}, [reload]);
	useEffect(() => {
		if (!enabled) {
			setState({ ...initial, loading: false });
			return;
		}
		const controller = new AbortController();
		setState((current) => ({ ...current, loading: true }));
		void (async () => {
			let status: ProviderStatus | null = null;
			try {
				const body = await listProviders(controller.signal);
				status = body.providers.find((provider) => provider.provider === "chatgpt") ?? null;
				let models: ProviderModel[] = [];
				let catalogAvailable = false;
				if (catalog && status?.status === "connected") {
					const response = await listChatgptModels(selected, controller.signal);
					models = response.models;
					catalogAvailable = response.catalogAvailable;
					if (status.status !== response.status) status.status = response.status;
				}
				if (!controller.signal.aborted) setState({ available: true, loading: false, status, models, catalogAvailable, error: null });
			} catch (error) {
				if (controller.signal.aborted) return;
				const hidden = error instanceof AtlasApiError && (error.status === 404 || error.status === 403);
				setState({ ...initial, available: !hidden, loading: false, status: hidden ? null : status, error: hidden ? null : "Não foi possível carregar o ChatGPT. Tente novamente." });
			}
		})();
		return () => controller.abort();
	}, [catalog, selected, version, enabled]);
	return { ...state, reload };
}
