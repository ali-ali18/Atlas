import { resolveColor } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { botColors } from "./bot-color";
import { useHomeData } from "./home-data";
import { themeColor } from "./theme";
import { useAppColorScheme } from "./use-theme";

/** Cor de destaque do bot (a do botão de enviar e dos interruptores), e o próprio bot da home. */
export function useBotAccent(botId: string) {
	const scheme = useAppColorScheme();
	const { snapshot } = useHomeData();
	const bot = snapshot?.bots.find((item) => item.id === botId);
	const accent = React.useMemo(() => botColors(resolveColor(bot?.color, botId), { accent: themeColor(scheme, "primary"), foreground: themeColor(scheme, "primary-foreground") }).accent, [bot?.color, botId, scheme]);
	return { bot, accent };
}

/** Texto que o chat já abre no campo para pedir a mudança de uma rotina ao bot. */
export function editRoutineDraft(name: string): string {
	return `Quero mudar a rotina "${name}": `;
}

/** Texto que o chat abre no campo para pedir uma rotina nova. */
export const CREATE_ROUTINE_DRAFT = "Quero criar uma rotina: ";
