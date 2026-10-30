"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UsagePeriod, UsageResponse } from "@workspace/shared";
import { getUsage } from "@/lib/atlas-api";
import { activeT } from "@/lib/i18n/active";

/** Fuso do navegador (o "hoje" do usuário); UTC quando o runtime não informa. */
function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/**
 * Uso do período escolhido. Recarrega ao trocar o período e ignora respostas
 * antigas (trocar rápido não mostra o período errado). Só carrega com `enabled`.
 */
export function useUsage(period: UsagePeriod, enabled = true) {
	const [data, setData] = useState<UsageResponse | null>(null);
	const [loading, setLoading] = useState(enabled);
	const [error, setError] = useState<string | null>(null);
	const requestRef = useRef(0);

	const load = useCallback(() => {
		const request = ++requestRef.current;
		setLoading(true);
		setError(null);
		setData(null);
		getUsage(period, browserTimeZone())
			.then((next) => {
				if (request === requestRef.current) setData(next);
			})
			.catch(() => {
				if (request === requestRef.current) setError(activeT("errors.loadUsage"));
			})
			.finally(() => {
				if (request === requestRef.current) setLoading(false);
			});
	}, [period]);

	useEffect(() => {
		if (!enabled) return;
		load();
		return () => {
			requestRef.current++;
		};
	}, [enabled, load]);

	return { data, loading, error, reload: load };
}
