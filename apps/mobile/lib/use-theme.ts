import * as React from "react";
import { useColorScheme } from "react-native";
import type { ColorScheme } from "./theme";

/** Tela que fixa o tema (ex.: o Computador é sempre escuro, como no Grok), qualquer que seja o do sistema. */
const ForcedScheme = React.createContext<ColorScheme | null>(null);
export const ForcedColorScheme = ForcedScheme.Provider;

/** Segue o tema do sistema (no web, `prefers-color-scheme`) a menos que uma tela o fixe. Sem preferência, usa o claro. */
export function useAppColorScheme(): ColorScheme {
	const forced = React.useContext(ForcedScheme);
	const system = useColorScheme();
	return forced ?? (system === "dark" ? "dark" : "light");
}
