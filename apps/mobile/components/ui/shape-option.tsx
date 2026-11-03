import { projectFrame } from "@workspace/shared/avatar/render/project";
import { stillFrame } from "@workspace/shared/avatar/render/still";
import { AVATAR_VIEWBOX, groupTransform } from "@workspace/shared/avatar/render/svg";
import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import { Avatar } from "@/components/ui/avatar";
import { RING_SCALE, RING_STROKE_PT } from "@/lib/shape-ring";
import { chatChrome } from "@/lib/chat-surface";
import { useAppColorScheme } from "@/lib/use-theme";

/** Lado da caixa do motor (o `viewBox` é 0 0 250 250): o ring cresce em torno do centro dela. */
const BOX = 250;
const CENTER = BOX / 2;

/** Contorno que acompanha a silhueta da forma (o mesmo caminho do motor, só traço, atrás do avatar). */
export function ShapeRing({ shape, size }: { shape: string; size: number }) {
	const scheme = useAppColorScheme();
	const { transform, body } = React.useMemo(() => {
		const frame = stillFrame(shape, "neutral");
		return { transform: groupTransform(frame), body: projectFrame(frame).body };
	}, [shape]);
	// A espessura vale em unidades do motor: 2 pt na tela, já descontando a escala do contorno.
	const strokeWidth = (RING_STROKE_PT * BOX) / size / RING_SCALE;
	return (
		<View pointerEvents="none" style={StyleSheet.absoluteFill} className="items-center justify-center">
			<Svg width={size} height={size} viewBox={AVATAR_VIEWBOX}>
				<G transform={`translate(${CENTER} ${CENTER}) scale(${RING_SCALE}) translate(${-CENTER} ${-CENTER}) ${transform}`}>
					<Path d={body} fill="none" stroke={chatChrome(scheme).edge} strokeWidth={strokeWidth} strokeLinejoin="round" />
				</G>
			</Svg>
		</View>
	);
}

/**
 * Uma forma da grade de escolha: o avatar na cor dada e, quando escolhida, o contorno que segue o formato dela. É a
 * mesma peça no "Criar novo Bot" e no editor de avatar. `cell` é o lado da célula tocável; `size` o do avatar.
 */
export function ShapeOption({ shape, color, label, selected, cell, size, eyeColor, onPress }: { shape: string; color: string; label: string; selected: boolean; cell: number; size: number; eyeColor: string; onPress: () => void }) {
	return (
		<Pressable role="radio" accessibilityLabel={label} accessibilityState={{ checked: selected }} onPress={onPress} style={{ width: cell, height: cell }} className="items-center justify-center">
			{selected ? <ShapeRing shape={shape} size={size} /> : null}
			<Avatar color={color} shape={shape} size={size} animated={false} eyeColor={eyeColor} />
		</Pressable>
	);
}
