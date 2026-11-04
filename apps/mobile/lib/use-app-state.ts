import * as React from "react";
import { AppState } from "react-native";

/** `AppState.currentState` do React Native, atualizado a cada mudança (active, inactive, background). */
export function useAppState(): string {
	const [state, setState] = React.useState<string>(AppState.currentState ?? "active");
	React.useEffect(() => {
		const subscription = AppState.addEventListener("change", setState);
		return () => subscription.remove();
	}, []);
	return state;
}
