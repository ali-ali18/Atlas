import * as React from "react";
import { ScrollView, type ScrollViewProps, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Tela rolável com o cabeçalho FLUTUANTE (o mesmo desenho da home): o cabeçalho fica em posição absoluta no topo, com a
 * área segura, e o conteúdo rola por baixo dele, SEM fundo nem degradê atrás do botão (sem faixa opaca que corte a lista).
 * A altura do cabeçalho é medida (`onLayout`) e vira o respiro no topo do conteúdo. Use dentro de um `ScreenFrame` com
 * `edges={["bottom", "left", "right"]}` (o topo seguro é deste componente).
 */
export function FloatingHeaderScroll({ header, children, contentContainerStyle, ...props }: ScrollViewProps & { header: React.ReactNode }) {
	const insets = useSafeAreaInsets();
	const [headerHeight, setHeaderHeight] = React.useState(0);
	return (
		<View className="flex-1">
			<ScrollView className="flex-1" contentContainerStyle={[{ paddingTop: headerHeight + 16 }, contentContainerStyle]} scrollIndicatorInsets={{ top: headerHeight }} {...props}>
				{children}
			</ScrollView>
			<View className="absolute left-0 right-0 top-0 z-10" style={{ paddingTop: insets.top }} onLayout={(event) => setHeaderHeight(Math.round(event.nativeEvent.layout.height))}>
				{header}
			</View>
		</View>
	);
}
