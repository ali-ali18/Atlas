// Superfícies do painel, dos mesmos tokens do web (`background`, `card`, `border`, `muted`): fundo da tela, cartão,
// contorno suave (`border-border/60`), cabeçalho de tabela (`bg-muted/40`) e as cores de texto.
import { hexAlpha } from "./color-math";
import { type ColorScheme, colorTokens } from "./color-tokens";

export type PageSurface = {
	screen: string;
	card: string;
	/** `border-border/60`. */
	edge: string;
	/** Trilho de barra e fundo de selo (`bg-muted`). */
	track: string;
	/** `bg-muted/40`: cabeçalho de tabela, coluna do kanban. */
	soft: string;
	foreground: string;
	muted: string;
};

export function pageSurface(scheme: ColorScheme): PageSurface {
	const tokens = colorTokens[scheme];
	return { screen: tokens.background, card: tokens.card, edge: hexAlpha(tokens.border, 0.6), track: tokens.muted, soft: hexAlpha(tokens.muted, 0.4), foreground: tokens.foreground, muted: tokens["muted-foreground"] };
}
