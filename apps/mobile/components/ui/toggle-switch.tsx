import * as React from "react";
import { Pressable } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";

const TRACK_WIDTH = 56;
const TRACK_HEIGHT = 34;
const THUMB = 25;
const INSET = (TRACK_HEIGHT - THUMB) / 2;

/**
 * Interruptor do Grok (medido no print): trilho 56x34 na cor do bot quando ligado, bolinha branca de 25. O `Switch`
 * do RN muda de desenho por plataforma; este é o mesmo em todas.
 */
export function ToggleSwitch({ value, onValueChange, color, offColor, disabled = false, accessibilityLabel }: { value: boolean; onValueChange: (value: boolean) => void; color: string; offColor: string; disabled?: boolean; accessibilityLabel: string }) {
	const reduced = useReducedMotion();
	const progress = useSharedValue(value ? 1 : 0);
	React.useEffect(() => {
		progress.value = reduced ? (value ? 1 : 0) : withTiming(value ? 1 : 0, { duration: 160, easing: Easing.out(Easing.cubic) });
	}, [value, reduced, progress]);
	const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * (TRACK_WIDTH - THUMB - INSET * 2) }] }));
	return (
		<Pressable role="switch" accessibilityState={{ checked: value, disabled }} accessibilityLabel={accessibilityLabel} disabled={disabled} onPress={() => onValueChange(!value)} hitSlop={8} style={{ width: TRACK_WIDTH, height: TRACK_HEIGHT, borderRadius: TRACK_HEIGHT / 2, padding: INSET, backgroundColor: value ? color : offColor, opacity: disabled ? 0.6 : 1 }}>
			<Animated.View style={[{ width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: "#ffffff" }, thumbStyle]} />
		</Pressable>
	);
}
