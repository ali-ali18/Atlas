import type { ColorScheme } from "./color-tokens";
import { surfaceColors } from "./surfaces";

// Compatibilidade: as cores moram em `lib/surfaces.ts`. Estas funções só mantêm os nomes antigos (outras branches ainda
// importam daqui); código novo usa `surfaceColors`/`useSurfaces`.

/** Balão do bot (`"bubble"`) e cartão da tabela (`"card"`, agora a superfície padrão). */
export function chatSurface(scheme: ColorScheme, kind: "bubble" | "card" = "bubble"): string {
	const colors = surfaceColors(scheme);
	return kind === "card" ? colors.surface : colors.bubble;
}

/** Chrome do chat: campo, botões redondos, topo. */
export function chatChrome(scheme: ColorScheme): { fill: string; edge: string; control: string } {
	const colors = surfaceColors(scheme);
	return { fill: colors.chromeFill, edge: colors.chromeEdge, control: colors.chromeControl };
}

/** Telas de Rotinas: agora usam o mesmo fundo e cartão de todas as telas. */
export function routineSurface(scheme: ColorScheme): { screen: string; card: string; edge: string; link: string; off: string } {
	const colors = surfaceColors(scheme);
	return { screen: colors.screen, card: colors.surface, edge: colors.surfaceEdge, link: colors.link, off: colors.switchOff };
}
