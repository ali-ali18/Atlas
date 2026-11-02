import { useColorScheme } from "react-native";
import type { ColorScheme } from "./theme";

/** Segue o tema do sistema (no web, `prefers-color-scheme`). Sem preferência, usa o claro. */
export function useAppColorScheme(): ColorScheme {
	return useColorScheme() === "dark" ? "dark" : "light";
}
