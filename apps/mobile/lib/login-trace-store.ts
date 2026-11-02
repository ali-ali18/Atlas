import AsyncStorage from "@react-native-async-storage/async-storage";
import * as React from "react";
import { createLoginTrace } from "@/lib/login-trace";

const TRACE_KEY = "atlas.login-trace";

/** Registro único do app (sobrevive a o Expo Go recarregar o app ao receber o link de volta). */
export const loginTrace = createLoginTrace({
	get: () => AsyncStorage.getItem(TRACE_KEY),
	set: (value) => AsyncStorage.setItem(TRACE_KEY, value),
});

export function useLoginTrace(): readonly string[] {
	React.useEffect(() => {
		void loginTrace.load();
	}, []);
	return React.useSyncExternalStore(loginTrace.subscribe, loginTrace.get, loginTrace.get);
}
