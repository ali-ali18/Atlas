"use client";

import { useCallback, useEffect, useState } from "react";
import type { EmailDomainDto } from "@workspace/shared";
import { AtlasApiError, addEmailDomain, listEmailDomains, removeEmailDomain, verifyEmailDomain } from "@/lib/atlas-api";

function messageOf(cause: unknown, fallback: string): string {
	return cause instanceof AtlasApiError && cause.message ? cause.message : fallback;
}

/**
 * Domínios próprios da conta (OpenMail, plano pago): lista, adicionar (devolve os registros DNS),
 * verificar e remover. `enabled` só carrega quando a chave do provedor existe.
 */
export function useEmailDomains(enabled: boolean) {
	const [domains, setDomains] = useState<EmailDomainDto[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setDomains(await listEmailDomains());
			setError(null);
		} catch (cause) {
			setError(messageOf(cause, "Não foi possível carregar os domínios."));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (enabled) void refresh();
		else setDomains(null);
	}, [enabled, refresh]);

	const run = useCallback(async (id: string, action: () => Promise<void>, fallback: string): Promise<boolean> => {
		setBusyId(id);
		setError(null);
		try {
			await action();
			return true;
		} catch (cause) {
			setError(messageOf(cause, fallback));
			return false;
		} finally {
			setBusyId(null);
		}
	}, []);

	return {
		domains,
		loading,
		error,
		busyId,
		refresh,
		add: (domain: string) =>
			run("new", async () => {
				const created = await addEmailDomain(domain);
				setDomains((current) => [...(current ?? []).filter((item) => item.id !== created.id), created]);
			}, "Não foi possível adicionar o domínio. Tente novamente."),
		verify: (id: string) =>
			run(id, async () => {
				const next = await verifyEmailDomain(id);
				setDomains((current) => (current ?? []).map((item) => (item.id === next.id ? next : item)));
			}, "Não foi possível verificar agora. Tente novamente."),
		remove: (id: string) =>
			run(id, async () => {
				await removeEmailDomain(id);
				setDomains((current) => (current ?? []).filter((item) => item.id !== id));
			}, "Não foi possível remover o domínio. Tente novamente."),
	};
}
