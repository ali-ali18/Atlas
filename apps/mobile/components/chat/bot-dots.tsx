import * as React from "react";
import { View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming, type SharedValue } from "react-native-reanimated";

const CYCLE_MS = 1_200;

function Dot({ phase, size, color, progress, still }: { phase: number; size: number; color: string; progress: SharedValue<number>; still: boolean }) {
	const style = useAnimatedStyle(() => {
		if (still) return { opacity: 1, transform: [{ scale: 1 }] };
		// Cada bolinha pulsa na sua vez (defasagem de um terço do ciclo).
		const wave = Math.max(0, Math.sin((progress.value - phase) * Math.PI * 2));
		return { opacity: 0.55 + 0.45 * wave, transform: [{ scale: 1 + 0.35 * wave }] };
	});
	return <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]} />;
}

/**
 * Três bolinhas na cor do bot, a do meio maior, pulsando em sequência (a linha "Verificando novas mensagens…" e o
 * "pensando" do bot). Com "reduzir movimento" no sistema ficam paradas.
 */
export function BotDots({ color }: { color: string }) {
	const reduced = useReducedMotion();
	const progress = useSharedValue(0);
	React.useEffect(() => {
		if (reduced) return;
		progress.value = 0;
		progress.value = withRepeat(withTiming(1, { duration: CYCLE_MS, easing: Easing.linear }), -1, false);
		return () => cancelAnimation(progress);
	}, [reduced, progress]);
	return (
		<View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="h-5 w-9 flex-row items-center justify-between">
			<Dot phase={0} size={6} color={color} progress={progress} still={reduced} />
			<Dot phase={1 / 3} size={9} color={color} progress={progress} still={reduced} />
			<Dot phase={2 / 3} size={6} color={color} progress={progress} still={reduced} />
		</View>
	);
}
