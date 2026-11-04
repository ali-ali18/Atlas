import type { ColorScheme } from "./color-tokens";
import { surfaceColors } from "./surfaces";

// Compatibilidade: as cores moram em `lib/surfaces.ts`. Estas funções só mantêm os nomes antigos (outras branches ainda
// importam daqui); código novo usa `surfaceColors`/`useSurfaces`.

/** Balão do bot (`"bubble"`) e cartão do chat (`"card"`, a casca `chatCard`, quase igual ao balão). */
export function chatSurface(scheme: ColorScheme, kind: "bubble" | "card" = "bubble"): string {
	const colors = surfaceColors(scheme);
	return kind === "card" ? colors.chatCard : colors.bubble;
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

/** Contorno do cartão do chat (tabela, propostas): o contorno padrão do cartão. */
export function chatCardEdge(scheme: ColorScheme): string {
	return surfaceColors(scheme).surfaceEdge;
}

/** Pele do cartão do chat (tabela, propostas): a casca `chatCard` com contorno e raio de cartão. */
export function chatCardSkin(scheme: ColorScheme) {
	const colors = surfaceColors(scheme);
	return { backgroundColor: colors.chatCard, borderWidth: 1, borderColor: colors.surfaceEdge, borderRadius: 21 } as const;
}

/** Fundo do botão secundário dentro de um cartão do chat (o `bg-secondary` do tema some contra a casca). */
export function chatCardControl(scheme: ColorScheme) {
	return { backgroundColor: surfaceColors(scheme).chatCardControl } as const;
}
