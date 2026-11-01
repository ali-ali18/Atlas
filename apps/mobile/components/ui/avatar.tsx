import { eyeColorFor } from "@workspace/shared/avatar/identity";
import { projectFrame } from "@workspace/shared/avatar/render/project";
import { stillFrame } from "@workspace/shared/avatar/render/still";
import { AVATAR_VIEWBOX, groupTransform } from "@workspace/shared/avatar/render/svg";
import * as React from "react";
import { View } from "react-native";
import Animated, {
	Easing,
	useAnimatedProps,
	useAnimatedStyle,
	useReducedMotion,
	useSharedValue,
	withRepeat,
	withSequence,
	withTiming,
} from "react-native-reanimated";
import Svg, { G, Path } from "react-native-svg";
import { PUSH_AVATAR_BACKGROUND } from "@workspace/shared";
import { cn } from "@/lib/cn";
import { useAppColorScheme } from "@/lib/use-theme";

export type AvatarProps = {
	/** Rótulo acessível (`role="img"`). Sem ele o avatar é decorativo. */
	ariaLabel?: string;
	className?: string;
	/** Cor do corpo. Padrão: branco no tema escuro e `#09090b` no claro (o branco sumiria no fundo claro). */
	color?: string;
	shape?: string;
	/** Lado da caixa do SVG em px. O corpo ocupa uns 70% dela (a caixa de 250 do motor tem margem). */
	size?: number;
	/** Vivo: respira e pisca. Desligado (ou com "reduzir movimento" no sistema) fica no quadro de repouso. */
	animated?: boolean;
};

// Tempos do motor do web (BEHAVIOR_TUNING e CHARACTER_TUNING em packages/shared/src/avatar/model):
// piscada de 0,12 s que fecha até 10% (blinkMin 0,1) e reabre; intervalo de 2 a 6 s; 18% das vezes uma
// segunda piscada 0,28 s depois.
const BLINK_S = 0.12;
const BLINK_MIN = 0.1;
const BLINK_EVERY_S = [2, 6] as const;
const DOUBLE_BLINK_CHANCE = 0.18;
const DOUBLE_BLINK_GAP_S = 0.28;

const AnimatedG = Animated.createAnimatedComponent(G);

/**
 * Avatar do Atlas. Mesmo nome e props do Avatar de packages/ui. O desenho vem do mesmo motor
 * (`stillFrame` + `projectFrame`, em @workspace/shared); o movimento é uma versão básica do motor do web:
 * respiração (escala, flutuação e leve balanço) e piscada. Ficam de fora o olhar que segue o toque, os
 * estados do cérebro e os clipes 3D de repouso (Idle_A/B/D), que dependem do loop de quadros do motor.
 */
export function Avatar({ ariaLabel, className, color, shape = "blob", size = 120, animated = true }: AvatarProps) {
	const scheme = useAppColorScheme();
	const reducedMotion = useReducedMotion();
	const live = animated && !reducedMotion;

	const bodyColor = color ?? (scheme === "dark" ? "#ffffff" : PUSH_AVATAR_BACKGROUND);
	const eyeColor = eyeColorFor(bodyColor);
	const { transform, body, eyes, eyeCy } = React.useMemo(() => {
		const frame = stillFrame(shape, "neutral");
		const projected = projectFrame(frame);
		return {
			transform: groupTransform(frame),
			body: projected.body,
			eyes: projected.eyes,
			eyeCy: (frame.eyes[0].cy + frame.eyes[1].cy) / 2,
		};
	}, [shape]);

	// Respiração: um ciclo de 3,6 s (vai e volta), fase única para escala, flutuação e balanço.
	const breath = useSharedValue(0);
	const lid = useSharedValue(1);

	React.useEffect(() => {
		if (!live) {
			breath.value = 0;
			return;
		}
		breath.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.sin) }), -1, true);
	}, [live, breath]);

	React.useEffect(() => {
		lid.value = 1;
		if (!live) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const half = (BLINK_S / 2) * 1000;
		const blink = () => {
			lid.value = withSequence(withTiming(BLINK_MIN, { duration: half }), withTiming(1, { duration: half }));
		};
		const schedule = (seconds: number) => {
			timer = setTimeout(() => {
				blink();
				const double = Math.random() < DOUBLE_BLINK_CHANCE;
				schedule(double ? DOUBLE_BLINK_GAP_S : BLINK_EVERY_S[0] + Math.random() * (BLINK_EVERY_S[1] - BLINK_EVERY_S[0]));
			}, seconds * 1000);
		};
		schedule(BLINK_EVERY_S[0] + Math.random() * (BLINK_EVERY_S[1] - BLINK_EVERY_S[0]));
		return () => clearTimeout(timer);
	}, [live, lid]);

	const bodyStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: (breath.value - 0.5) * size * 0.03 }, { rotate: `${(breath.value - 0.5) * 5}deg` }, { scale: 1 + breath.value * 0.035 }],
	}));

	// Piscar = achatar os olhos na vertical em torno da linha dos olhos (o motor reduz o comprimento do olho).
	const eyesProps = useAnimatedProps(() => ({
		transform: [{ translateY: eyeCy }, { scaleY: lid.value }, { translateY: -eyeCy }],
	}));

	return (
		<View
			role={ariaLabel ? "img" : undefined}
			accessibilityLabel={ariaLabel}
			accessible={Boolean(ariaLabel)}
			style={{ width: size, height: size }}
			className={cn("items-center justify-center", className)}
		>
			<Animated.View style={[{ width: size, height: size }, bodyStyle]}>
				<Svg width={size} height={size} viewBox={AVATAR_VIEWBOX}>
					<G transform={transform}>
						<Path d={body} fill={bodyColor} />
						<AnimatedG animatedProps={eyesProps}>
							<Path d={eyes} fill={eyeColor} />
						</AnimatedG>
					</G>
				</Svg>
			</Animated.View>
		</View>
	);
}
