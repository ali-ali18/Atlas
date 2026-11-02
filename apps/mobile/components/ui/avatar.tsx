import { projectFrame } from "@workspace/shared/avatar/render/project";
import { stillFrame } from "@workspace/shared/avatar/render/still";
import { AVATAR_VIEWBOX, groupTransform } from "@workspace/shared/avatar/render/svg";
import * as React from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
	Easing,
	useAnimatedStyle,
	useReducedMotion,
	useSharedValue,
	type SharedValue,
	cancelAnimation,
	withRepeat,
	withSequence,
	withTiming,
} from "react-native-reanimated";
import Svg, { G, Path } from "react-native-svg";
import { PUSH_AVATAR_BACKGROUND } from "@workspace/shared";
import type { MobileAvatarState } from "@/lib/avatar-activity";
import { poseFrame, type Pose } from "@/lib/avatar-pose";
import { SPIN_PERIOD_S, spinPoseAtStep, spinStep } from "@/lib/avatar-spin";
import { cn } from "@/lib/cn";
import { themeColor } from "@/lib/theme";
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
	/**
	 * O que o bot está fazendo: cada estado tem uma expressão do motor e uma animação simples (sem o "cérebro" do web).
	 * Sem `state`, vale `mood` (`happy` é atalho do estado `happy`; o resto é `idle`).
	 */
	state?: MobileAvatarState;
	/**
	 * Cor dos olhos. Os olhos são pintados por cima do corpo (um recorte com `<Mask>` não deixaria animá-los no Android),
	 * então o padrão é a cor de fundo do tema, que dá a ilusão do recorte. Passe a cor da superfície quando o avatar
	 * não estiver sobre o fundo da tela (cartão, fundo fixo do splash).
	 */
	eyeColor?: string;
	/**
	 * Repouso vivo: respira (escala, flutuação e balanço). Igual ao `breathe` do web, que vem desligado:
	 * o avatar do painel de marca do login fica com o corpo parado e só pisca.
	 */
	breathe?: boolean;
	/** Olhar: de tempos em tempos os olhos passeiam para um ponto e voltam (as olhadas do motor do web). */
	look?: boolean;
	/**
	 * Pose 3D parada (yaw/pitch/roll do motor), para as listas, que no web também ficam paradas. Use com `animated={false}`:
	 * a respiração e a piscada do app não combinam com o corpo girado.
	 */
	pose?: Pose;
	/**
	 * Giro contínuo no próprio eixo vertical (yaw de 360°, o `spin` do motor do web em laço), para a tela "Conectando".
	 * Usa o motor de verdade: a cada passo de 7,5° pega o quadro do motor naquele yaw (`poseFrame` + `projectFrame`, em cache)
	 * e redesenha; o centro fica fixo. O corpo vem inclinado (`SPIN_BASE_POSE`: de lado, olhando para cima) e o giro é o yaw em torno
	 * desse eixo. Só gira com `animated` (e sem "reduzir movimento"); senão fica parado nessa pose inclinada.
	 */
	spin?: boolean;
	/** Segundos por volta do `spin`. */
	spinPeriodS?: number;
};

/** Quadros projetados já calculados (forma, expressão e pose): o giro repete os mesmos 48 yaws a cada volta. */
const projectedCache = new Map<string, { body: string; eyes: string }>();

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
const ROLL: readonly Key[] = [[0.08, 0], [0.59, 14.2], [1.14, -21.7], [1.97, -1.1], [2.27, 0]];
// Tremida de gelatina (só do app, o web tem o corpo 3D): depois de cada aterrissagem do pulo (0,77 s, 1,25 s, 1,62 s e
// 1,84 s) o corpo balança em oscilações que vão morrendo (+1, -0,8, +0,6...), esticando e achatando de leve e girando
// um pouco, para não parecer uma pedra caindo. Usa o mesmo tempo absoluto do clipe.
const JIGGLE: readonly Key[] = [
	[0.77, 0], [0.83, 1], [0.89, -0.8], [0.95, 0.6], [1.01, -0.4], [1.07, 0.25], [1.13, 0],
	[1.25, 0], [1.3, 1], [1.36, -0.8], [1.42, 0.5], [1.48, -0.3], [1.54, 0.15], [1.6, 0],
	[1.62, 0], [1.67, 1], [1.73, -0.8], [1.79, 0.5], [1.85, -0.3], [1.91, 0.2], [1.97, -0.1], [2.05, 0],
];
const JIGGLE_SCALE = 0.06; // 6% de esticada/achatada no pico
const JIGGLE_DEG = 5;
/** Duração do clipe (3,7 s) mais uma pausa antes do próximo, onde ele só respira e pisca. */
const DANCE_EVERY_S = 4.6;
const BODY_RADIUS_RATIO = 0.3525; // raio do corpo / lado da caixa (o corpo ocupa ~70,5% dela)

// Olhadas do motor do web (BEHAVIOR_TUNING e `glance()` em behavior.ts): a cada 3 a 8 s um ponto sorteado
// (x de -0,9 a 0,9, y de -0,5 a 0,5) que fica 0,7 a 1,4 s. No web, quem vira é o corpo em 3D e os olhos só
// têm resíduo de 1,2px; aqui o corpo fica parado e os olhos andam até LOOK_MAX_PX na horizontal e LOOK_MAX_Y_PX na vertical (decisão do dono).
const LOOK_EVERY_S = [3, 8] as const;
const LOOK_HOLD_S = [0.7, 1.4] as const;
const LOOK_X = 0.9;
const LOOK_Y = 0.5;
// O deslocamento dos olhos é proporcional ao lado do avatar (9 px e 5 px num de 120): em px fixos, no avatar de 32 do topo
// e da linha "Pensando…" os olhos saíam do corpo (corpo de ~22 px).
const LOOK_MAX_RATIO = 9 / 120;
const LOOK_MAX_Y_RATIO = 5 / 120;
// Expressão de cada estado do app (as do motor, em packages/shared/src/avatar/model/expressions.ts).
const STATE_EXPRESSION: Record<MobileAvatarState, string> = {
	idle: "neutral",
	thinking: "neutral",
	searching: "neutral",
	reading: "calm",
	working: "squinted",
	writing: "neutral",
	waiting: "neutral",
	happy: "happy",
	failed: "sad",
};
/** Piscar mais seguido enquanto escreve. */
const WRITING_BLINK_EVERY_S = [0.9, 2.2] as const;
const between = (range: readonly [number, number]) => range[0] + Math.random() * (range[1] - range[0]);

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
 * respiração (escala, flutuação e leve balanço) e piscada, mais um gesto simples por estado (`state`). Ficam de
 * fora o olhar que segue o toque, o cérebro (indicadores, morphs, anel) e os clipes 3D de repouso (Idle_A/B/D),
 * que dependem do loop de quadros do motor.
 */
export function Avatar({ ariaLabel, className, color, shape = "blob", size = 120, animated = true, mood = "neutral", state, eyeColor: eyeColorProp, breathe = false, look = true, pose: poseProp, spin = false, spinPeriodS = SPIN_PERIOD_S }: AvatarProps) {
	const scheme = useAppColorScheme();
	const reducedMotion = useReducedMotion();
	const live = animated && !reducedMotion;

	// Giro: um laço de quadros troca o passo de yaw (no máximo 48 por volta); só redesenha quando o passo muda.
	const spinning = spin && live;
	// Com `spin` o corpo vem inclinado (de lado, olhando para cima); sem movimento fica parado nessa pose (passo 0).
	const [step, setStep] = React.useState(0);
	React.useEffect(() => {
		if (!spinning) {
			setStep(0);
			return;
		}
		const startedAt = Date.now();
		let frameId = 0;
		const tick = () => {
			setStep(spinStep((Date.now() - startedAt) / 1000, spinPeriodS));
			frameId = requestAnimationFrame(tick);
		};
		frameId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frameId);
	}, [spinning, spinPeriodS]);
	const pose = spin ? spinPoseAtStep(spinning ? step : 0) : poseProp;
	const poseYaw = pose?.yaw;
	const posePitch = pose?.pitch;
	const poseRoll = pose?.roll;

	const bodyColor = color ?? (scheme === "dark" ? "#ffffff" : PUSH_AVATAR_BACKGROUND);
	const current: MobileAvatarState = state ?? (mood === "happy" ? "happy" : "idle");
	const eyeColor = eyeColorProp ?? themeColor(scheme, "background");
	const { transform, body, eyes, eyeCy } = React.useMemo(() => {
		const expression = STATE_EXPRESSION[current];
		const frame = poseYaw !== undefined ? poseFrame(shape, expression, { yaw: poseYaw, pitch: posePitch ?? 0, roll: poseRoll ?? 0 }) : stillFrame(shape, expression);
		const key = `${shape}|${expression}|${poseYaw}|${posePitch}|${poseRoll}`;
		let projected = projectedCache.get(key);
		if (!projected) {
			projected = projectFrame(frame);
			projectedCache.set(key, projected);
		}
		return {
			transform: groupTransform(frame),
			body: projected.body,
			eyes: projected.eyes,
			eyeCy: (frame.eyes[0].cy + frame.eyes[1].cy) / 2,
		};
	}, [shape, current, poseYaw, posePitch, poseRoll]);

	// Respiração: um ciclo de 3,6 s (vai e volta), fase única para escala, flutuação e balanço.
	const breath = useSharedValue(0);
	const lid = useSharedValue(1);
	const hop = useSharedValue(0);
	const squashX = useSharedValue(1);
	const squashY = useSharedValue(1);
	const roll = useSharedValue(0);
	const jiggle = useSharedValue(0);
	const tilt = useSharedValue(0);
	const headY = useSharedValue(0);
	const gazeX = useSharedValue(0);
	const gazeY = useSharedValue(0);
	const radius = size * BODY_RADIUS_RATIO;

	React.useEffect(() => {
		if (!live || !breathe) {
			breath.value = 0.5; // ponto neutro: sem deslocamento, giro nem escala extra
			return;
		}
		breath.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.sin) }), -1, true);
	}, [live, breathe, breath]);

	// Olhar e postura por estado. Em repouso os olhos passeiam de vez em quando (as olhadas do motor); nos demais
	// estados o olhar e a cabeça têm um gesto próprio e simples. Tudo parado sem `live`.
	React.useEffect(() => {
		cancelAnimation(gazeX);
		cancelAnimation(gazeY);
		cancelAnimation(tilt);
		cancelAnimation(headY);
		const settle = { duration: 450, easing: Easing.inOut(Easing.cubic) };
		const sweep = (from: number, to: number, ms: number) => {
			gazeX.value = from;
			gazeX.value = withRepeat(withTiming(to, { duration: ms, easing: Easing.inOut(Easing.sin) }), -1, true);
		};
		gazeX.value = withTiming(0, settle);
		gazeY.value = withTiming(0, settle);
		tilt.value = withTiming(0, settle);
		headY.value = withTiming(0, settle);
		if (!live) {
			gazeX.value = 0;
			gazeY.value = 0;
			tilt.value = 0;
			headY.value = 0;
			return;
		}
		switch (current) {
			case "thinking":
				// Olha para cima e inclina a cabeça de leve, balançando devagar.
				gazeX.value = withTiming(-LOOK_X * 0.6, settle);
				gazeY.value = withTiming(-LOOK_Y, settle);
				tilt.value = -3;
				tilt.value = withRepeat(withTiming(-9, { duration: 1500, easing: Easing.inOut(Easing.sin) }), -1, true);
				return;
			case "searching":
				sweep(-LOOK_X, LOOK_X, 650);
				return;
			case "reading":
				// Cabeça um pouco baixa e o olhar correndo devagar, como numa linha de texto.
				headY.value = withTiming(size * 0.035, settle);
				gazeY.value = withTiming(LOOK_Y * 0.8, settle);
				sweep(-LOOK_X * 0.7, LOOK_X * 0.7, 1700);
				return;
			case "working":
				headY.value = withRepeat(withTiming(size * 0.02, { duration: 320, easing: Easing.inOut(Easing.quad) }), -1, true);
				return;
			case "failed":
				headY.value = withTiming(size * 0.03, settle);
				tilt.value = withTiming(-4, settle);
				return;
			case "idle": {
				if (!look) return;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const schedule = () => {
					timer = setTimeout(() => {
						gazeX.value = withTiming((Math.random() * 2 - 1) * LOOK_X, { duration: 380, easing: Easing.out(Easing.cubic) });
						gazeY.value = withTiming((Math.random() * 2 - 1) * LOOK_Y, { duration: 380, easing: Easing.out(Easing.cubic) });
						timer = setTimeout(() => {
							gazeX.value = withTiming(0, settle);
							gazeY.value = withTiming(0, settle);
							schedule();
						}, between(LOOK_HOLD_S) * 1000);
					}, between(LOOK_EVERY_S) * 1000);
				};
				schedule();
				return () => clearTimeout(timer);
			}
			default:
				// writing, waiting e happy: olhando para frente.
				return;
		}
	}, [live, look, current, size, gazeX, gazeY, tilt, headY]);

	React.useEffect(() => {
		lid.value = 1;
		if (!live) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const half = (BLINK_S / 2) * 1000;
		const blink = () => {
			lid.value = withSequence(withTiming(BLINK_MIN, { duration: half }), withTiming(1, { duration: half }));
		};
		const every = current === "writing" ? WRITING_BLINK_EVERY_S : BLINK_EVERY_S;
		const schedule = (seconds: number) => {
			timer = setTimeout(() => {
				blink();
				const double = Math.random() < DOUBLE_BLINK_CHANCE;
				schedule(double ? DOUBLE_BLINK_GAP_S : between(every));
			}, seconds * 1000);
		};
		schedule(between(every));
		return () => clearTimeout(timer);
	}, [live, lid, current]);

	// Dança: o clipe Done_A repete a cada DANCE_EVERY_S enquanto o humor é feliz.
	React.useEffect(() => {
		hop.value = 0;
		squashX.value = 1;
		squashY.value = 1;
		roll.value = 0;
		jiggle.value = 0;
		if (!live || current !== "happy") return;
		const play = () => {
			playTrack(hop, HOP, -radius);
			playTrack(squashX, SQUASH_X);
			playTrack(squashY, SQUASH_Y);
			playTrack(roll, ROLL);
			playTrack(jiggle, JIGGLE);
		};
		const first = setTimeout(play, 400);
		const loop = setInterval(play, DANCE_EVERY_S * 1000);
		return () => {
			clearTimeout(first);
			clearInterval(loop);
		};
	}, [live, current, radius, hop, squashX, squashY, roll, jiggle]);

	const bodyStyle = useAnimatedStyle(() => {
		// Agachar/esticar ancorado na base do corpo (anchor -1 do clipe): a escala vertical cresce para cima.
		const anchorShift = -radius * (squashY.value - 1);
		return {
			transform: [
				{ translateY: hop.value + anchorShift + headY.value + (breath.value - 0.5) * size * 0.03 },
				{ rotate: `${(breath.value - 0.5) * 5 + roll.value + tilt.value + jiggle.value * JIGGLE_DEG}deg` },
				{ scaleX: (1 + (breath.value - 0.5) * 0.035) * squashX.value * (1 + jiggle.value * JIGGLE_SCALE) },
				{ scaleY: (1 + (breath.value - 0.5) * 0.035) * squashY.value * (1 - jiggle.value * JIGGLE_SCALE) },
			],
		};
	});

	// Os olhos ficam num Svg próprio, dentro de um Animated.View sobreposto ao corpo: animar o `transform` de um
	// <G> via `useAnimatedProps` funciona no web mas não no react-native-svg nativo (o olhar e a piscada
	// ficavam parados no Android). Estilo animado de View funciona nas duas plataformas, também no Expo Go.
	// Piscar = achatar os olhos na vertical em torno da linha dos olhos (o motor reduz o comprimento do olho):
	// a escala do RN é em torno do centro da caixa, então compensa com um translateY de (cy - centro) * (1 - lid).
	const eyeCyPx = (eyeCy / 250) * size;
	const eyesStyle = useAnimatedStyle(() => ({
		transform: [
			{ translateX: (gazeX.value / LOOK_X) * size * LOOK_MAX_RATIO },
			{ translateY: (gazeY.value / LOOK_Y) * size * LOOK_MAX_Y_RATIO },
			{ translateY: (eyeCyPx - size / 2) * (1 - lid.value) },
			{ scaleY: lid.value },
		],
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
					</G>
				</Svg>
				<Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, eyesStyle]}>
					<Svg width={size} height={size} viewBox={AVATAR_VIEWBOX}>
						<G transform={transform}>
							<Path d={eyes} fill={eyeColor} />
						</G>
					</Svg>
				</Animated.View>
			</Animated.View>
		</View>
	);
}
