"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApiKeyProvider, ApiKeyProviderStatus, ProviderModel } from "@workspace/shared";
import {
	AtlasApiError,
	listProviderKeyModels,
	listProviderKeys,
	removeProviderKey,
	saveProviderKey,
	testProviderKey,
} from "@/lib/atlas-api";
import { notifyProvidersChanged } from "@/lib/provider-connect";
import { activeT } from "@/lib/i18n/active";

/** Mensagem curta para a UI; nunca ecoa a chave. */
function message(error: unknown, fallback: string): string {
	return error instanceof AtlasApiError && error.message ? error.message : fallback;
}

/** Estado das chaves próprias: listar, colar (já testa), retestar e remover. */
export function useProviderKeys() {
	const [statuses, setStatuses] = useState<Partial<Record<ApiKeyProvider, ApiKeyProviderStatus>>>({});
	const [vaultReady, setVaultReady] = useState(true);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<ApiKeyProvider | null>(null);
	const [errors, setErrors] = useState<Partial<Record<ApiKeyProvider, string>>>({});
	const [version, setVersion] = useState(0);
	const reload = useCallback(() => setVersion((value) => value + 1), []);

	useEffect(() => {
		const controller = new AbortController();
		void listProviderKeys(controller.signal)
			.then((body) => {
				setStatuses(Object.fromEntries(body.providers.map((status) => [status.provider, status])));
				setVaultReady(body.vaultReady);
			})
			.catch(() => undefined)
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [version]);

	const run = useCallback(async (provider: ApiKeyProvider, action: () => Promise<void>, fallback: string) => {
		setBusy(provider);
		setErrors((current) => ({ ...current, [provider]: undefined }));
		try {
			await action();
			notifyProvidersChanged();
			reload();
		} catch (error) {
			setErrors((current) => ({ ...current, [provider]: message(error, fallback) }));
		} finally {
			setBusy(null);
		}
	}, [reload]);

	return {
		statuses,
		vaultReady,
		loading,
		busy,
		errors,
		save: (provider: ApiKeyProvider, apiKey: string) => run(provider, async () => void (await saveProviderKey(provider, apiKey)), activeT("errors.connectRetry")),
		test: (provider: ApiKeyProvider) => run(provider, async () => void (await testProviderKey(provider)), activeT("errors.testConnection")),
		remove: (provider: ApiKeyProvider) => run(provider, async () => void (await removeProviderKey(provider)), activeT("errors.removeKey")),
		reload,
	};
}

/** Modelos dos provedores por chave que estão conectados (para os seletores de modelo). */
export function useKeyProviderModels(enabled = true) {
	const [groups, setGroups] = useState<Partial<Record<ApiKeyProvider, ProviderModel[]>>>({});
	const [version, setVersion] = useState(0);
	useEffect(() => {
		const onChanged = () => setVersion((value) => value + 1);
		window.addEventListener("atlas:providers-changed", onChanged);
		return () => window.removeEventListener("atlas:providers-changed", onChanged);
	}, []);
	useEffect(() => {
		if (!enabled) {
			setGroups({});
			return;
		}
		const controller = new AbortController();
		void (async () => {
			const next: Partial<Record<ApiKeyProvider, ProviderModel[]>> = {};
			try {
				const { providers } = await listProviderKeys(controller.signal);
				await Promise.all(
					providers
						.filter((status) => status.status === "connected")
						.map(async (status) => {
							const result = await listProviderKeyModels(status.provider, controller.signal).catch(() => null);
							if (result?.models.length) next[status.provider] = result.models;
						}),
				);
			} catch {
				// Sem sessão ou API fora do ar: o seletor segue sem esses grupos.
			}
			if (!controller.signal.aborted) setGroups(next);
		})();
		return () => controller.abort();
	}, [enabled, version]);
	return groups;
}
