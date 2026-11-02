import { botAccent } from "@workspace/shared";

// `botAccent`, `relativeLuminance` e `BotAccent` moraram aqui; agora estão em `@workspace/shared` (o app mobile usa os
// mesmos). Só as variáveis CSS, que são do web, ficam neste arquivo.
export { botAccent, relativeLuminance, type BotAccent } from "@workspace/shared";

/**
 * Variáveis CSS do destaque do bot (painel + botão de enviar do composer).
 * Sem cor válida devolve `{}` e quem usa cai no `primary` do tema.
 */
export function botAccentStyle(color: string | undefined): Record<string, string> {
	const accent = botAccent(color);
	if (!accent) return {};
	return {
		"--bot-accent": accent.accent,
		"--bot-accent-foreground": accent.foreground,
		"--ring": accent.accent,
	};
}
