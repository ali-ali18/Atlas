"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getReflectionStatus, runReflectionNow, type ReflectionStatusView } from "@/lib/atlas-api";
import { useHubEvents, useHubPollMode } from "@/hooks/use-event-hub";

const POLL_MS = 4000;
const DEGRADED_POLL_MS = 60_000;

/** Estado da reflexão e "Refletir agora". Consulta de novo enquanto há uma em andamento. */
export function useReflectionStatus(enabled: boolean) {
	const [view, setView] = useState<ReflectionStatusView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pollMode = useHubPollMode();

	const refresh = useCallback(async () => {
		try {
			setView(await getReflectionStatus());
		} catch {
			// Estado é só informativo: sem rede, a linha some.
		}
	}, []);

	useEffect(() => {
		if (!enabled) return;
		void refresh();
	}, [enabled, refresh]);

	// Com o hub conectado a reflexão avisa por evento; sem ele, consulta a cada 4 s enquanto ativa (60 s se o hub caiu).
	useHubEvents(["reflection"], () => void refresh(), enabled);
	useEffect(() => {
		if (!enabled || !view?.active || pollMode === "hub") return;
		timer.current = setTimeout(() => void refresh(), pollMode === "degraded" ? DEGRADED_POLL_MS : POLL_MS);
		return () => {
			if (timer.current) clearTimeout(timer.current);
		};
	}, [enabled, view, refresh, pollMode]);

	const runNow = useCallback(async () => {
		setError(null);
		setStarting(true);
		try {
			await runReflectionNow();
			setView((current) => (current ? { ...current, active: true } : current));
			void refresh();
		} catch (cause) {
			setError(cause instanceof Error && cause.message ? cause.message : "Não foi possível iniciar a reflexão.");
		} finally {
			setStarting(false);
		}
	}, [refresh]);

	return { view, error, starting, runNow, refresh };
}
