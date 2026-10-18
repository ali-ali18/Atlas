"use client";

import { useEffect, useRef, useState } from "react";
import { listMcpConnections } from "@/lib/atlas-api";

function normalize(url: string): string {
	return url.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Acompanha se o MCP personalizado desta URL ficou conectado (feito no dialog
 * "MCP personalizado"). Recarrega ao voltar para a aba e enquanto o card está pendente.
 */
export function useCustomMcpConnection(url: string, enabled: boolean) {
	const [connected, setConnected] = useState(false);
	const [justConnected, setJustConnected] = useState(false);
	const connectedRef = useRef(false);

	useEffect(() => {
		if (!enabled || !url) return;
		let alive = true;
		const load = (initial: boolean) =>
			listMcpConnections()
				.then((items) => {
					if (!alive) return;
					const now = items.some((item) => !item.catalogId && item.status === "connected" && normalize(item.url) === normalize(url));
					if (now && !connectedRef.current && !initial) setJustConnected(true);
					connectedRef.current = now;
					setConnected(now);
				})
				.catch(() => undefined);
		void load(true);
		const refresh = () => {
			if (document.visibilityState === "visible" && !connectedRef.current) void load(false);
		};
		document.addEventListener("visibilitychange", refresh);
		window.addEventListener("focus", refresh);
		// O dialog conecta na mesma aba: confere de vez em quando enquanto o card espera.
		const timer = window.setInterval(refresh, 4000);
		return () => {
			alive = false;
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", refresh);
			window.removeEventListener("focus", refresh);
		};
	}, [enabled, url]);

	return { connected, justConnected };
}
