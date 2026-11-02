import * as React from "react";
import { View } from "react-native";
import { themeVars } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

/**
 * O `Modal` do RN abre numa raiz nativa própria, fora da View que injeta as variáveis de cor do tema:
 * sem esta casca os tokens (`bg-popover`, `text-foreground`) ficam sem valor dentro dele.
 */
export function ThemedModalRoot({ children }: { children: React.ReactNode }) {
	const scheme = useAppColorScheme();
	return <View style={[{ flex: 1 }, themeVars(scheme)]}>{children}</View>;
}
