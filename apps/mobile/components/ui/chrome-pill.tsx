import * as React from "react";
import { Pressable, View } from "react-native";
import { cn } from "@/lib/cn";
import { useSurfaces } from "@/lib/use-surfaces";

type ChromePillProps = {
	children: React.ReactNode;
	/** Altura em dp (padrão: a do botão redondo do topo, 47); `null` deixa o conteúdo definir (chips). */
	height?: number | null;
	className?: string;
	/** Com `onPress` a pílula é um botão (então `label` é obrigatório). */
	onPress?: () => void;
	label?: string;
};

/**
 * Pílula com borda: a do bot no topo do chat, chips de resposta. Mesmo preenchimento e contorno do `ChromeButton`
 * (`chromeFill`/`chromeEdge`). Sem `onPress` é só um contêiner; com `onPress` vira botão acessível.
 */
export function ChromePill({ children, height = 47, className, onPress, label }: ChromePillProps) {
	const surfaces = useSurfaces();
	const style = { ...(height === null ? {} : { height }), borderColor: surfaces.chromeEdge, backgroundColor: surfaces.chromeFill };
	if (!onPress) {
		return (
			<View style={style} className={cn("flex-row items-center rounded-full border", className)}>
				{children}
			</View>
		);
	}
	return (
		<Pressable role="button" accessibilityLabel={label} onPress={onPress} style={style} className={cn("flex-row items-center rounded-full border active:opacity-80", className)}>
			{children}
		</Pressable>
	);
}
