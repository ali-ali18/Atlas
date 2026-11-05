import * as React from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { type FadeCurve, fadeStops } from "@/lib/fade-stops";
import { useSurfaces } from "@/lib/use-surfaces";

let counter = 0;

/**
 * Degradê do fundo para transparente (`from="top"`: opaco em cima, some para baixo). Põe o fundo "por baixo" do topo
 * flutuante e do composer: as mensagens somem suavemente sob eles (o do composer é o `bg-linear-to-t from-background`
 * do web). `curve="linear"` (home e Configurações): 2 stops, transição uniforme na altura toda; o padrão segura
 * opacidade alta até 55% (chat). Não pega toque.
 */
export function Fade({ height, from, curve = "default", className }: { height: number; from: "top" | "bottom"; curve?: FadeCurve; className?: string }) {
	// Mesma cor que o `ScreenFrame` pinta (`surfaces.screen`): no escuro difere do token `background` e daria uma faixa.
	const color = useSurfaces().screen;
	const id = React.useMemo(() => `fade-${counter++}`, []);
	return (
		<View pointerEvents="none" className={className} style={{ height }}>
			<Svg width="100%" height="100%" preserveAspectRatio="none">
				<Defs>
					<LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
						{fadeStops(from, curve).map((stop) => (
							<Stop key={stop.offset} offset={stop.offset} stopColor={color} stopOpacity={stop.opacity} />
						))}
					</LinearGradient>
				</Defs>
				<Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
			</Svg>
		</View>
	);
}
