import * as React from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

let counter = 0;

/**
 * Degradê do fundo para transparente (`from="top"`: opaco em cima, some para baixo). Põe o fundo "por baixo" do topo
 * flutuante e do composer: as mensagens somem suavemente sob eles (o do composer é o `bg-linear-to-t from-background`
 * do web). Não pega toque.
 */
export function Fade({ height, from, className }: { height: number; from: "top" | "bottom"; className?: string }) {
	const scheme = useAppColorScheme();
	const color = themeColor(scheme, "background");
	const id = React.useMemo(() => `fade-${counter++}`, []);
	return (
		<View pointerEvents="none" className={className} style={{ height }}>
			<Svg width="100%" height="100%" preserveAspectRatio="none">
				<Defs>
					<LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
						<Stop offset="0" stopColor={color} stopOpacity={from === "top" ? 1 : 0} />
						<Stop offset="0.55" stopColor={color} stopOpacity={from === "top" ? 0.85 : 0.15} />
						<Stop offset="1" stopColor={color} stopOpacity={from === "top" ? 0 : 1} />
					</LinearGradient>
				</Defs>
				<Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
			</Svg>
		</View>
	);
}
