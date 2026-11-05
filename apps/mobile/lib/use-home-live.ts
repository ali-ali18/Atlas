// Home em primeiro plano: ao voltar o foco para a tela (de um chat, de Configurações) confere o servidor, e sem o
// canal de eventos faz uma consulta a cada 45 s. Com o canal conectado, os avisos bastam (ver `home-live.ts`).
import { useFocusEffect } from "expo-router";
import * as React from "react";
import { AppState } from "react-native";
import { HOME_POLL_MS, startFallbackPoller } from "./event-hub-client";
import { useAtlasSession } from "./atlas-session";
import { useHomeData } from "./home-data";

export function useHomeLive(): void {
	const { eventHub } = useAtlasSession();
	const { refresh, snapshot } = useHomeData();
	const refreshRef = React.useRef(refresh);
	refreshRef.current = refresh;
	const focused = React.useRef(false);
	const firstFocus = React.useRef(true);
	const ready = snapshot !== null;

	useFocusEffect(
		React.useCallback(() => {
			focused.current = true;
			// A primeira vez é do carregamento inicial; as seguintes (voltou de outra tela) conferem em silêncio.
			if (firstFocus.current) firstFocus.current = false;
			else void refreshRef.current({ silent: true });
			return () => {
				focused.current = false;
			};
		}, []),
	);

	React.useEffect(() => {
		if (!ready) return;
		return startFallbackPoller({
			hub: eventHub,
			appState: {
				current: () => AppState.currentState ?? "active",
				subscribe: (listener) => {
					const subscription = AppState.addEventListener("change", listener);
					return () => subscription.remove();
				},
			},
			intervalMs: HOME_POLL_MS,
			isFocused: () => focused.current,
			tick: () => void refreshRef.current({ silent: true }),
		});
	}, [eventHub, ready]);
}
