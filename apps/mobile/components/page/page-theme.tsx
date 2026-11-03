import type { PageNode, PagePalette, PageTone } from "@workspace/shared";
import * as React from "react";
import { type ChartColors, resolvePageColors } from "@/lib/chart-palette";
import { type PageSurface, pageSurface } from "@/lib/page-surface";
import { type ToneColors, toneColors } from "@/lib/page-tone";

/** Um filho já desenhado e o nó de origem (o contêiner decide o espaço de cada um pelo nó). */
export type RenderedChild = { node: PageNode; element: React.ReactNode };
export type Of<T extends PageNode["type"]> = Extract<PageNode, { type: T }>;

export type PageTheme = {
	scheme: "light" | "dark";
	/** Paleta do painel (pronta, própria ou nenhuma = visual padrão): dela vêm o destaque, a tendência e as séries dos gráficos. */
	palette: PagePalette | undefined;
};

export const PageThemeContext = React.createContext<PageTheme>({ scheme: "dark", palette: undefined });

/** Cores do painel já resolvidas para o esquema e a paleta: superfícies, tom -> cores e a paleta dos gráficos. */
export function usePageTheme() {
	const { scheme, palette } = React.useContext(PageThemeContext);
	return React.useMemo(
		() => ({
			scheme,
			surface: pageSurface(scheme) satisfies PageSurface,
			chartColors: resolvePageColors(scheme, palette) satisfies ChartColors,
			tone: (tone: PageTone | undefined): ToneColors => toneColors(scheme, tone, palette),
		}),
		[scheme, palette],
	);
}
