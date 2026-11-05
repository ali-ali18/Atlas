// A home se atualiza sozinha com os avisos do canal de eventos: mensagem, leitura, bot e run (`affectsBotList`)
// pedem uma atualização, junta numa só por uma janela curta (rajada de eventos = um fetch), e `ready`/`resync` ou a
// volta ao primeiro plano refazem o retrato. Sem React: o teste injeta hub, relógio e AppState.
import type { EventHub } from "./event-hub";
import type { AppStateLike } from "./event-hub-client";

export const HOME_REFRESH_DEBOUNCE_MS = 300;

export type HomeLiveDeps = {
	hub: Pick<EventHub, "subscribeBots" | "onResync"> | null;
	appState: AppStateLike;
	/** Atualização silenciosa (sem o giro do puxar-para-atualizar). */
	refresh: () => void;
	debounceMs?: number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
};

/** Devolve a parada. Sem hub só cuida da volta ao primeiro plano. */
export function attachHomeLive(deps: HomeLiveDeps): () => void {
	const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const wait = deps.debounceMs ?? HOME_REFRESH_DEBOUNCE_MS;
	let timer: unknown = null;
	let stopped = false;
	// Janela única: eventos dentro dela viram um refresh só, no fim da janela (não adia para sempre numa rajada longa).
	const request = () => {
		if (stopped || timer !== null) return;
		timer = schedule(() => {
			timer = null;
			if (!stopped) deps.refresh();
		}, wait);
	};
	const offs: (() => void)[] = [];
	if (deps.hub) {
		offs.push(deps.hub.subscribeBots(request));
		offs.push(deps.hub.onResync(request));
	}
	let last = deps.appState.current();
	offs.push(
		deps.appState.subscribe((state) => {
			if (state === "active" && last !== "active") request();
			last = state;
		}),
	);
	return () => {
		stopped = true;
		if (timer !== null) cancel(timer);
		timer = null;
		for (const off of offs) off();
	};
}
