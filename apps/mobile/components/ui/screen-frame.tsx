import * as React from "react";
import type { ViewProps } from "react-native";
import { type Edge, SafeAreaView } from "react-native-safe-area-context";
import { cn } from "@/lib/cn";
import { useSurfaces } from "@/lib/use-surfaces";

/**
 * Contêiner de TODA tela: área segura + o fundo padrão do app (`screen`, o do chat). Tela nenhuma pinta o próprio
 * fundo. `edges` escolhe as bordas seguras (o chat tira o topo porque a barra flutua sobre as mensagens).
 */
export function ScreenFrame({ children, edges, className, style, ...props }: ViewProps & { edges?: readonly Edge[] }) {
	const surfaces = useSurfaces();
	return (
		<SafeAreaView edges={edges} style={[{ backgroundColor: surfaces.screen }, style]} className={cn("flex-1", className)} {...props}>
			{children}
		</SafeAreaView>
	);
}
