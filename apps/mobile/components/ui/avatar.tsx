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
	type SharedValue,
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
	/**
	 * Humor. `happy`: olhos sorrindo ("^ ^", a expressão `happy` do motor) e, a cada poucos segundos, o
	 * pulinho do clipe Done_A do web (três pulos com agachar e esticar e um balanço). Sem "reduzir movimento",
	 * entre os pulos ele respira e pisca. `neutral`: só respira e pisca.
	 */
	mood?: "neutral" | "happy";
};

// Tempos do motor do web (BEHAVIOR_TUNING e CHARACTER_TUNING em packages/shared/src/avatar/model):
// piscada de 0,12 s que fecha até 10% (blinkMin 0,1) e reabre; intervalo de 2 a 6 s; 18% das vezes uma
// segunda piscada 0,28 s depois.
const BLINK_S = 0.12;
const BLINK_MIN = 0.1;
const BLINK_EVERY_S = [2, 6] as const;
const DOUBLE_BLINK_CHANCE = 0.18;
const DOUBLE_BLINK_GAP_S = 0.28;

// Clipe Done_A do motor do web (packages/shared/src/avatar/model/clip-data.ts, 3,7 s), reduzido ao que cabe
// em 2D: [tempo s, valor]. `HOP` é a altura em raios do corpo; `SQUASH_X/Y` a escala (ancorada na base do
// corpo, como `anchor: -1`); `ROLL` o balanço em graus. Fora do que dá: o pitch/yaw 3D do clipe.
type Key = readonly [number, number];
const HOP: readonly Key[] = [[0.22, 0], [0.41, 0.27], [0.77, 0], [0.99, 0.27], [1.25, 0], [1.43, 0.21], [1.62, 0], [1.69, 0.13], [1.84, 0], [1.87, 0.08], [1.95, 0]];
const SQUASH_X: readonly Key[] = [[0.03, 1], [0.17, 1.095], [0.25, 1], [0.59, 1], [0.71, 1], [0.77, 1.095], [0.99, 1], [1.2, 1], [1.24, 1.02], [1.37, 1], [1.57, 1], [1.72, 1]];
const SQUASH_Y: readonly Key[] = [[0.03, 1], [0.17, 0.95], [0.25, 1.1], [0.59, 1], [0.71, 1], [0.77, 0.95], [0.99, 1.05], [1.2, 1], [1.24, 0.95], [1.37, 1.05], [1.57, 1.05], [1.72, 1]];
const ROLL_PEAK_DEG = 21.7;
/** No web o balanço é 3D (pitch/yaw). Girar o corpo no plano deixa o avatar "de ladinho", então aqui o corpo
 * gira no máximo ±3° e o resto vira um deslocamento horizontal dos olhos (±2px), que lê como virar a cabeça. */
const BODY_TILT_MAX_DEG = 3;
const EYE_YAW_MAX_PX = 2;
const ROLL: readonly Key[] = [[0.08, 0], [0.59, 14.2], [1.14, -21.7], [1.97, -1.1], [2.27, 0]];
/** Duração do clipe (3,7 s) mais uma pausa antes do próximo, onde ele só respira e pisca. */
const DANCE_EVERY_S = 4.6;
const BODY_RADIUS_RATIO = 0.3525; // raio do corpo / lado da caixa (o corpo ocupa ~70,5% dela)

const AnimatedG = Animated.createAnimatedComponent(G);

/** Toca `keys` (tempo absoluto do clipe) num valor compartilhado; sobe com ease-out e desce com ease-in. */
function playTrack(target: SharedValue<number>, keys: readonly Key[], scale = 1) {
	let previousT = 0;
	let previousV = 0;
	const steps = keys.map(([t, v]) => {
		const goingUp = v >= previousV;
		const step = withTiming(v * scale, {
			duration: Math.max(1, (t - previousT) * 1000),
			easing: goingUp ? Easing.out(Easing.quad) : Easing.in(Easing.quad),
		});
		previousT = t;
		previousV = v;
		return step;
	});
	target.value = withSequence(...steps);
}

/**
 * Avatar do Atlas. Mesmo nome e props do Avatar de packages/ui. O desenho vem do mesmo motor
 * (`stillFrame` + `projectFrame`, em @workspace/shared); o movimento é uma versão básica do motor do web:
 * respiração (escala, flutuação e leve balanço de 2°) e piscada. Ficam de fora o olhar que segue o toque, os
 * estados do cérebro e os clipes 3D de repouso (Idle_A/B/D), que dependem do loop de quadros do motor.
 */
export function Avatar({ ariaLabel, className, color, shape = "blob", size = 120, animated = true, mood = "neutral" }: AvatarProps) {
	const scheme = useAppColorScheme();
	const reducedMotion = useReducedMotion();
	const live = animated && !reducedMotion;

	const bodyColor = color ?? (scheme === "dark" ? "#ffffff" : PUSH_AVATAR_BACKGROUND);
	const eyeColor = eyeColorFor(bodyColor);
	const { transform, body, eyes, eyeCy } = React.useMemo(() => {
		const frame = stillFrame(shape, mood === "happy" ? "happy" : "neutral");
		const projected = projectFrame(frame);
		return {
			transform: groupTransform(frame),
			body: projected.body,
			eyes: projected.eyes,
			eyeCy: (frame.eyes[0].cy + frame.eyes[1].cy) / 2,
		};
	}, [shape, mood]);

	// Respiração: um ciclo de 3,6 s (vai e volta), fase única para escala, flutuação e balanço.
	const breath = useSharedValue(0);
	const lid = useSharedValue(1);
	const hop = useSharedValue(0);
	const squashX = useSharedValue(1);
	const squashY = useSharedValue(1);
	const roll = useSharedValue(0);
	const radius = size * BODY_RADIUS_RATIO;

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

	// Dança: o clipe Done_A repete a cada DANCE_EVERY_S enquanto o humor é feliz.
	React.useEffect(() => {
		hop.value = 0;
		squashX.value = 1;
		squashY.value = 1;
		roll.value = 0;
		if (!live || mood !== "happy") return;
		const play = () => {
			playTrack(hop, HOP, -radius);
			playTrack(squashX, SQUASH_X);
			playTrack(squashY, SQUASH_Y);
			playTrack(roll, ROLL);
		};
		const first = setTimeout(play, 400);
		const loop = setInterval(play, DANCE_EVERY_S * 1000);
		return () => {
			clearTimeout(first);
			clearInterval(loop);
		};
	}, [live, mood, radius, hop, squashX, squashY, roll]);

	const bodyStyle = useAnimatedStyle(() => {
		// Agachar/esticar ancorado na base do corpo (anchor -1 do clipe): a escala vertical cresce para cima.
		const anchorShift = -radius * (squashY.value - 1);
		return {
			transform: [
				{ translateY: hop.value + anchorShift + (breath.value - 0.5) * size * 0.03 },
				{ rotate: `${(breath.value - 0.5) * 2 + (roll.value / ROLL_PEAK_DEG) * BODY_TILT_MAX_DEG}deg` },
				{ scaleX: (1 + breath.value * 0.035) * squashX.value },
				{ scaleY: (1 + breath.value * 0.035) * squashY.value },
			],
		};
	});

	// Piscar = achatar os olhos na vertical em torno da linha dos olhos (o motor reduz o comprimento do olho).
	const eyesProps = useAnimatedProps(() => ({
		// Yaw simulado: o deslocamento é em px da tela, convertido para unidades do viewBox (250).
		transform: [{ translateX: (roll.value / ROLL_PEAK_DEG) * EYE_YAW_MAX_PX * (250 / size) }, { translateY: eyeCy }, { scaleY: lid.value }, { translateY: -eyeCy }],
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
