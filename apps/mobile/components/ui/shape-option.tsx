import { projectFrame } from "@workspace/shared/avatar/render/project";
import { stillFrame } from "@workspace/shared/avatar/render/still";
import { groupTransform } from "@workspace/shared/avatar/render/svg";
import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import { Avatar } from "@/components/ui/avatar";
import { ENGINE_BOX, RING_PAD_UNITS, ringBoxSize, ringStrokes } from "@/lib/shape-ring";
import { chatChrome } from "@/lib/chat-surface";
import { useAppColorScheme } from "@/lib/use-theme";

/** A caixa do motor (`viewBox` 0 0 250 250) com margem de cada lado para o contorno. */
const RING_VIEWBOX = `${-RING_PAD_UNITS} ${-RING_PAD_UNITS} ${ENGINE_BOX + 2 * RING_PAD_UNITS} ${ENGINE_BOX + 2 * RING_PAD_UNITS}`;

/**
 * Contorno que acompanha a silhueta da forma a uma distância igual em toda a volta: o mesmo caminho do motor desenhado
 * duas vezes atrás do avatar, sem escala. Primeiro com traço largo na cor da borda, depois com traço mais fino na cor
 * da superfície por baixo, que abre o respiro. Escalar o caminho em torno do centro deixava o vão desigual nas formas
 * que não são simétricas (o triângulo ficava com o contorno longe em cima e colado embaixo).
 */
export function ShapeRing({ shape, size, surface }: { shape: string; size: number; surface: string }) {
	const scheme = useAppColorScheme();
	const transform = React.useMemo(() => groupTransform(stillFrame(shape, "neutral")), [shape]);
	const body = React.useMemo(() => projectFrame(stillFrame(shape, "neutral")).body, [shape]);
	const { outer, gap } = ringStrokes(size);
	return (
		<View pointerEvents="none" style={StyleSheet.absoluteFill} className="items-center justify-center">
			{/* Caixa maior que o avatar: o contorno passa da silhueta e sairia dos 250 do motor. */}
			<Svg width={ringBoxSize(size)} height={ringBoxSize(size)} viewBox={RING_VIEWBOX}>
				<G transform={transform}>
					<Path d={body} fill={chatChrome(scheme).edge} stroke={chatChrome(scheme).edge} strokeWidth={outer} strokeLinejoin="round" />
					<Path d={body} fill={surface} stroke={surface} strokeWidth={gap} strokeLinejoin="round" />
				</G>
			</Svg>
		</View>
	);
}

/**
 * Uma forma da grade de escolha: o avatar na cor dada e, quando escolhida, o contorno que segue o formato dela. É a
 * mesma peça no "Criar novo Bot" e no editor de avatar. `cell` é o lado da célula tocável; `size` o do avatar;
 * `surface` a cor do fundo onde a grade está (abre o respiro entre a forma e o contorno).
 */
export function ShapeOption({ shape, color, label, selected, cell, size, eyeColor, surface, onPress }: { shape: string; color: string; label: string; selected: boolean; cell: number; size: number; eyeColor: string; surface: string; onPress: () => void }) {
	return (
		<Pressable role="radio" accessibilityLabel={label} accessibilityState={{ checked: selected }} onPress={onPress} style={{ width: cell, height: cell }} className="items-center justify-center">
			{selected ? <ShapeRing shape={shape} size={size} surface={surface} /> : null}
			<Avatar color={color} shape={shape} size={size} animated={false} eyeColor={eyeColor} />
		</Pressable>
	);
}
