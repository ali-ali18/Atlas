import type { PageNode, PageTone } from "@workspace/shared";
import * as React from "react";
import { routineSurface } from "@/lib/chat-surface";
import { toneColors, type ToneColors } from "@/lib/page-tone";

/** Um filho já desenhado e o nó de origem (o contêiner decide o espaço de cada um pelo nó). */
export type RenderedChild = { node: PageNode; element: React.ReactNode };
export type Of<T extends PageNode["type"]> = Extract<PageNode, { type: T }>;

export type PageTheme = {
	scheme: "light" | "dark";
	/** Cor de destaque do painel (primeira cor da paleta `custom` validada), ou null = laranja da marca. */
	accent: string | null;
	/** Abre o painel/conversa no navegador (gráfico completo), se quem chama souber o endereço. */
	onOpenWeb?: () => void;
};

export const PageThemeContext = React.createContext<PageTheme>({ scheme: "dark", accent: null });

export function usePageTheme() {
	const theme = React.useContext(PageThemeContext);
	return React.useMemo(
		() => ({
			...theme,
			surface: routineSurface(theme.scheme),
			tone: (tone: PageTone | undefined): ToneColors => toneColors(theme.scheme, tone, theme.accent),
		}),
		[theme],
	);
}
