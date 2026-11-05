import { resolveColor } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { type BotColors, botColors } from "./bot-color";
import { usePreferences } from "./app-preferences";
import { resolveAccent } from "./preferences";
import { useHomeData } from "./home-data";
import { themeColor } from "./theme";
import { useAppColorScheme } from "./use-theme";

/** Cor de destaque do bot (a do botão de enviar e dos interruptores), e o próprio bot da home. */
export function useBotAccent(botId: string) {
	const { snapshot } = useHomeData();
	const bot = snapshot?.bots.find((item) => item.id === botId);
	const { accent } = useAccentColors(bot?.color, botId);
	return { bot, accent };
}

/** Destaque da interface (botão enviar, interruptores): a cor do bot ou, na preferência "Neutro", foreground/background do tema. Avatar nunca passa por aqui. */
export function useAccentColors(botColor: string | undefined, botId: string): BotColors {
	const scheme = useAppColorScheme();
	const { preferences } = usePreferences();
	return React.useMemo(() => {
		const neutral = { accent: themeColor(scheme, "foreground"), foreground: themeColor(scheme, "background") };
		const bot = botColors(resolveColor(botColor, botId), { accent: themeColor(scheme, "primary"), foreground: themeColor(scheme, "primary-foreground") });
		return resolveAccent(preferences.accent, bot, neutral);
	}, [botColor, botId, scheme, preferences.accent]);
}

/** Texto que o chat já abre no campo para pedir a mudança de uma rotina ao bot. */
export function editRoutineDraft(name: string): string {
	return `Quero mudar a rotina "${name}": `;
}

/** Texto que o chat abre no campo para pedir uma rotina nova. */
export const CREATE_ROUTINE_DRAFT = "Quero criar uma rotina: ";
