import { AVATAR_VIEWBOX } from "@workspace/shared/avatar/render/svg";
import * as React from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Defs, G, Path, RadialGradient, Stop } from "react-native-svg";

export type LaunchMascotFrame = {
	/** Contorno e olhos já projetados pelo motor (`projectFrame`). */
	body: string;
	eyes: string;
	/** Transform do grupo (`groupTransform`). */
	transform: string;
	/** Lado da caixa, em pt. */
	size: number;
};

type Props = LaunchMascotFrame & { eyeColor: string };

// Sombreado do corpo igual ao da imagem do splash nativo (`assets/splash-icon.png`), para o desenho do motor
// ocupar o lugar dela sem a esfera "achatar". Mesmo desenho do gerador do ícone: luz no alto à esquerda.
const SHADE = [
	["0", "#ffffff"],
	["0.5", "#fcfbfa"],
	["0.8", "#f1eeea"],
	["1", "#e6e2dc"],
] as const;

/**
 * O personagem da abertura: o quadro do motor (corpo e olhos) em dois `Svg`, como o `Avatar` (o olho fica numa camada
 * própria por cima do corpo, que é o jeito que funciona no react-native-svg nativo). Sem estado: quem anima passa o
 * quadro de cada instante.
 */
export const LaunchMascot = React.memo(function LaunchMascot({ body, eyes, transform, size, eyeColor }: Props) {
	return (
		<View style={{ width: size, height: size }}>
			<Svg width={size} height={size} viewBox={AVATAR_VIEWBOX}>
				<Defs>
					<RadialGradient id="launch-shade" cx="0.28" cy="0.12" r="1.15">
						{SHADE.map(([offset, color]) => (
							<Stop key={offset} offset={offset} stopColor={color} />
						))}
					</RadialGradient>
				</Defs>
				<G transform={transform}>
					<Path d={body} fill="url(#launch-shade)" />
				</G>
			</Svg>
			<View pointerEvents="none" style={StyleSheet.absoluteFill}>
				<Svg width={size} height={size} viewBox={AVATAR_VIEWBOX}>
					<G transform={transform}>
						<Path d={eyes} fill={eyeColor} />
					</G>
				</Svg>
			</View>
		</View>
	);
});
