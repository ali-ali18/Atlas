import * as React from "react";
import { Pressable } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { tap } from "@/lib/haptics";
import { useSurfaces } from "@/lib/use-surfaces";

const TRACK_WIDTH = 56;
const TRACK_HEIGHT = 34;
const THUMB = 25;
const INSET = (TRACK_HEIGHT - THUMB) / 2;

type ToggleSwitchProps = {
	value: boolean;
	onValueChange: (value: boolean) => void;
	/** Cor do trilho ligado (a do bot). Sem ela, o azul padrão do app (`link`). */
	color?: string;
	disabled?: boolean;
	accessibilityLabel: string;
};

/**
 * O ÚNICO interruptor do app (medido no Grok): trilho 56x34, bolinha branca de 25; desligado usa `switchOff`, ligado a
 * cor do bot. Nunca use o `Switch` do RN (muda de desenho por plataforma; o teste de guarda barra o import).
 */
export function ToggleSwitch({ value, onValueChange, color, disabled = false, accessibilityLabel }: ToggleSwitchProps) {
	const surfaces = useSurfaces();
	const reduced = useReducedMotion();
	const progress = useSharedValue(value ? 1 : 0);
	React.useEffect(() => {
		progress.value = reduced ? (value ? 1 : 0) : withTiming(value ? 1 : 0, { duration: 160, easing: Easing.out(Easing.cubic) });
	}, [value, reduced, progress]);
	const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * (TRACK_WIDTH - THUMB - INSET * 2) }] }));
	return (
		<Pressable role="switch" accessibilityState={{ checked: value, disabled }} accessibilityLabel={accessibilityLabel} disabled={disabled} onPress={() => {
				tap();
				onValueChange(!value);
			}} hitSlop={8} style={{ width: TRACK_WIDTH, height: TRACK_HEIGHT, borderRadius: TRACK_HEIGHT / 2, padding: INSET, backgroundColor: value ? (color ?? surfaces.link) : surfaces.switchOff, opacity: disabled ? 0.6 : 1 }}>
			<Animated.View style={[{ width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: surfaces.switchThumb }, thumbStyle]} />
		</Pressable>
	);
}
