import * as React from "react";
import { View } from "react-native";
import { Avatar } from "@/components/ui/avatar";
import { themeColor } from "@/lib/theme";
import { useSurfaces } from "@/lib/use-surfaces";
import { useAppColorScheme } from "@/lib/use-theme";

/** Uma volta da esfera, em segundos. */
export const BOT_LOADER_SPIN_S = 1.6;

export type BotLoaderProps = {
	/** Lado do bot em px. */
	size?: number;
	/** Rótulo para leitor de tela. Sem rótulo o bot é decorativo. */
	label?: string;
	/** Cor da esfera (padrão `muted-foreground` do tema). Telas de fundo fixo, como o Computador, passam a sua. */
	color?: string;
	/** Cor dos olhos, que somem atrás na volta (padrão: o fundo da tela). */
	eyeColor?: string;
};

/**
 * Carregamento de tela com a esfera do bot (forma `blob`) girando 360° no próprio eixo vertical, a mesma da tela
 * "Conectando" do Computador. O giro é o `spin` do `Avatar`; com "reduzir movimento" ele fica parado de frente.
 * Para carregamento pequeno, dentro de botão ou linha, continua o `Spinner`.
 */
export function BotLoader({ size = 72, label, color, eyeColor }: BotLoaderProps) {
	const scheme = useAppColorScheme();
	const surfaces = useSurfaces();
	return (
		<View {...(label ? { accessible: true, accessibilityRole: "progressbar" as const, accessibilityLabel: label } : { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const })}>
			<Avatar color={color ?? themeColor(scheme, "muted-foreground")} shape="blob" size={size} animated look={false} spin spinPeriodS={BOT_LOADER_SPIN_S} state="idle" eyeColor={eyeColor ?? surfaces.screen} />
		</View>
	);
}
