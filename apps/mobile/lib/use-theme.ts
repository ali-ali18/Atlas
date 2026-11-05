import * as React from "react";
import { useColorScheme } from "react-native";
import { usePreferences } from "./app-preferences";
import { resolveColorScheme } from "./preferences";
import type { ColorScheme } from "./theme";

/** Tela que fixa o tema (ex.: o Computador é sempre escuro, como no Grok), qualquer que seja o do sistema. */
const ForcedScheme = React.createContext<ColorScheme | null>(null);
export const ForcedColorScheme = ForcedScheme.Provider;

/** Tela fixa > escolha do dono em Configurações (Aparência) > tema do sistema (no web, `prefers-color-scheme`); sem nenhum, o claro. */
export function useAppColorScheme(): ColorScheme {
	const forced = React.useContext(ForcedScheme);
	const system = useColorScheme();
	const { preferences } = usePreferences();
	return forced ?? resolveColorScheme(preferences.theme, system);
}
