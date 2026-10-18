"use client";

import { useEffect, useRef, useState } from "react";

import type { HubEvent, HubStatus } from "@/lib/event-hub";
import { getSharedEventHub, pollModeFor, type HubPollMode } from "@/lib/event-hub-client";

/** Estado da conexão do hub (null = sem hub: desligado, servidor antigo ou fora do navegador). */
export function useHubStatus(): HubStatus | null {
	const [status, setStatus] = useState<HubStatus | null>(() => getSharedEventHub()?.getStatus() ?? null);
	useEffect(() => {
		const hub = getSharedEventHub();
		if (!hub) return;
		setStatus(hub.getStatus());
		return hub.onStatus(setStatus);
	}, []);
	return status;
}

export function useHubPollMode(): HubPollMode {
	return pollModeFor(useHubStatus());
}

/** Assina os eventos de um tipo (qualquer conversa). */
export function useHubEvents(types: readonly string[], handler: (event: HubEvent) => void, enabled = true) {
	const ref = useRef(handler);
	ref.current = handler;
	const key = types.join("|");
	useEffect(() => {
		const hub = getSharedEventHub();
		if (!hub || !enabled) return;
		const wanted = new Set(key.split("|"));
		return hub.subscribe((event) => {
			if (wanted.has(event.type)) ref.current(event);
		});
	}, [key, enabled]);
}
