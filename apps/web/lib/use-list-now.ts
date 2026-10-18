import { useSyncExternalStore } from "react";

// Relógio compartilhado da lista: um único intervalo para todas as linhas,
// e só elas re-renderizam (não o app inteiro).
const TICK_MS = 60_000;
let snapshot = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
	snapshot = Date.now();
	for (const listener of listeners) listener();
}

function onVisible() {
	if (document.visibilityState === "visible") tick();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (listeners.size === 1) {
		snapshot = Date.now();
		timer = setInterval(tick, TICK_MS);
		document.addEventListener("visibilitychange", onVisible);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			if (timer) clearInterval(timer);
			timer = null;
			document.removeEventListener("visibilitychange", onVisible);
		}
	};
}

/** "Agora" (ms) atualizado a cada minuto e ao voltar para a aba. */
export function useListNow(): number {
	return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
