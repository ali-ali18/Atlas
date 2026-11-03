import * as React from "react";
import { useColorScheme } from "react-native";
import type { ColorScheme } from "./theme";

/** Tela que fica sempre no mesmo tema, qualquer que seja o do sistema (o visualizador de imagens é sempre escuro). */
export const SchemeOverrideContext = React.createContext<ColorScheme | null>(null);

/** Segue o tema do sistema (no web, `prefers-color-scheme`), salvo dentro de um `SchemeOverrideContext`. Sem preferência, usa o claro. */
export function useAppColorScheme(): ColorScheme {
	const forced = React.useContext(SchemeOverrideContext);
	const system = useColorScheme();
	return forced ?? (system === "dark" ? "dark" : "light");
}
