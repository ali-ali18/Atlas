import { projectFrame } from "@workspace/shared/avatar/render/project";
import { stillFrame } from "@workspace/shared/avatar/render/still";
import { groupTransform } from "@workspace/shared/avatar/render/svg";
import * as React from "react";
import { Pressable } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import { cellViewBox, ringStrokes } from "@/lib/shape-ring";
import { chatChrome } from "@/lib/chat-surface";
import { useAppColorScheme } from "@/lib/use-theme";

/**
 * Uma forma da grade de escolha, na cor dada, e, quando escolhida, o contorno que segue o formato dela. É a mesma
 * peça no "Criar novo Bot" e no editor de avatar. `cell` é o lado da célula tocável; `size` o da forma; `surface` a
 * cor do fundo onde a grade está (abre o respiro entre a forma e o contorno).
 *
 * Forma, olhos e contorno saem do MESMO caminho do motor, num só desenho do tamanho da célula. Com o avatar e o
 * contorno em desenhos separados, cada um era centralizado por conta própria e o arredondamento deixava a forma
 * fora do centro do contorno (mais espaço de um lado que do outro). O contorno é o caminho desenhado duas vezes, sem
 * escala: traço largo na cor da borda e, por cima, traço fino na cor da superfície, o que mantém a mesma distância
 * em toda a volta, inclusive nas formas que não são simétricas.
 */
export function ShapeOption({ shape, color, label, selected, cell, size, eyeColor, surface, onPress }: { shape: string; color: string; label: string; selected: boolean; cell: number; size: number; eyeColor: string; surface: string; onPress: () => void }) {
	const scheme = useAppColorScheme();
	const { transform, body, eyes, scale } = React.useMemo(() => {
		const frame = stillFrame(shape, "neutral");
		const projected = projectFrame(frame);
		return { transform: groupTransform(frame), body: projected.body, eyes: projected.eyes, scale: frame.scale * frame.scaleX };
	}, [shape]);
	const { outer, gap } = ringStrokes(size, scale);
	const edge = chatChrome(scheme).edge;
	return (
		<Pressable role="radio" accessibilityLabel={label} accessibilityState={{ checked: selected }} onPress={onPress} style={{ width: cell, height: cell }}>
			<Svg width={cell} height={cell} viewBox={cellViewBox(cell, size)}>
				<G transform={transform}>
					{selected ? <Path d={body} fill={edge} stroke={edge} strokeWidth={outer} strokeLinejoin="round" /> : null}
					{selected ? <Path d={body} fill={surface} stroke={surface} strokeWidth={gap} strokeLinejoin="round" /> : null}
					<Path d={body} fill={color} />
					<Path d={eyes} fill={eyeColor} />
				</G>
			</Svg>
		</Pressable>
	);
}
