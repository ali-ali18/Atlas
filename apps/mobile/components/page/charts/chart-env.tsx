import * as React from "react";
import { View } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import { Easing, useAnimatedReaction, useReducedMotion, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Text } from "@/components/ui/text";
import type { ChartColors } from "@/lib/chart-palette";
import { colorTokens, type ColorScheme } from "@/lib/color-tokens";
import { hexAlpha } from "@/lib/color-math";

/** Cores de apoio do gráfico (eixo, grade, texto), dos mesmos tokens do web (`--chart-label`, `--chart-grid`…). */
export type ChartTheme = { scheme: ColorScheme; colors: ChartColors; foreground: string; label: string; grid: string; background: string };

export function chartTheme(scheme: ColorScheme, colors: ChartColors): ChartTheme {
	const tokens = colorTokens[scheme];
	return { scheme, colors, foreground: tokens.foreground, label: tokens["muted-foreground"], grid: hexAlpha(tokens.border, 0.9), background: tokens.background };
}

/**
 * Entrada suave do gráfico: 0 -> 1 em 700 ms. Com "reduzir movimento" ligado no sistema já nasce em 1 (sem animar).
 * O valor é compartilhado (thread de UI): animar não re-renderiza o gráfico.
 */
export function useEntrance(): SharedValue<number> {
	const reduce = useReducedMotion();
	const progress = useSharedValue(reduce ? 1 : 0);
	React.useEffect(() => {
		progress.value = reduce ? 1 : withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) });
	}, [reduce, progress]);
	return progress;
}

/** Cartão de valor ao tocar (título e uma linha por série), por cima do gráfico, nas cores do tooltip do web (`--popover`). */
export function PressCard({ scheme, title, rows }: { scheme: ColorScheme; title: string; rows: ReadonlyArray<{ color: string; label: string; value: string }> }) {
	const tokens = colorTokens[scheme];
	return (
		<View pointerEvents="none" className="absolute left-2 top-1 z-10 min-w-28 max-w-[80%] gap-1 rounded-lg border px-2.5 py-1.5" style={{ backgroundColor: tokens.popover, borderColor: tokens.border }}>
			<Text className="text-caption" style={{ color: tokens["muted-foreground"] }} numberOfLines={1}>
				{title}
			</Text>
			{rows.map((row) => (
				<View key={row.label} className="flex-row items-center gap-1.5">
					<View className="size-2 rounded-full" style={{ backgroundColor: row.color }} />
					<Text className="min-w-0 flex-1 text-caption" style={{ color: tokens["popover-foreground"] }} numberOfLines={1}>
						{row.label}
					</Text>
					<Text className="text-caption font-medium" style={{ color: tokens["popover-foreground"], fontVariant: ["tabular-nums"] }}>
						{row.value}
					</Text>
				</View>
			))}
		</View>
	);
}

/** Posição das marcas dos eixos em pt, dentro do gráfico (vem das escalas do Victory). */
export type AxisMarks = { bounds: { left: number; right: number; top: number; bottom: number }; y: Array<{ text: string; at: number }>; x: Array<{ text: string; at: number }> };

export type Scale = ((value: number) => number) & { domain: () => number[]; range: () => number[] };
const sameScale = (a: Scale | null, b: Scale) => a !== null && a.domain().join() === b.domain().join() && a.range().join() === b.range().join();

/**
 * Captura as escalas do Victory (que desenha os eixos dentro do Skia, com fonte) para pôr os rótulos como texto do
 * React Native: a mesma fonte do resto do app, tamanho que acompanha a acessibilidade e nada de fonte para carregar
 * (e funciona igual no celular e na prévia web). Só guarda se a escala mudou de fato (sem laço de renderização).
 */
export function useAxisScales() {
	const [scales, setScales] = React.useState<{ x: Scale; y: Scale } | null>(null);
	const [bounds, setBounds] = React.useState<AxisMarks["bounds"] | null>(null);
	const onScaleChange = React.useCallback((x: Scale, y: Scale) => setScales((previous) => (previous && sameScale(previous.x, x) && sameScale(previous.y, y) ? previous : { x, y })), []);
	const onChartBoundsChange = React.useCallback((next: AxisMarks["bounds"]) => setBounds((previous) => (previous && previous.left === next.left && previous.right === next.right && previous.top === next.top && previous.bottom === next.bottom ? previous : next)), []);
	return { scales, bounds, onScaleChange, onChartBoundsChange };
}

/** Rótulos dos eixos por cima do gráfico: Y alinhado à direita na margem esquerda, X centrado sob a marca (sem passar da borda). */
export function AxisOverlay({ marks, gutter, color, width, rowLabels = false }: { marks: AxisMarks; gutter: number; color: string; width: number; rowLabels?: boolean }) {
	const slot = 64;
	return (
		<View pointerEvents="none" className="absolute inset-0">
			{marks.y.map((mark) => (
				<Text key={`y${mark.text}${mark.at}`} className="absolute text-caption" numberOfLines={rowLabels ? 2 : 1} style={{ left: 0, width: gutter - 6, textAlign: "right", color, top: mark.at - (rowLabels ? 14 : 8), ...(rowLabels ? { height: 28 } : null) }}>
					{mark.text}
				</Text>
			))}
			{marks.x.map((mark) => {
				const left = Math.min(Math.max(0, mark.at - slot / 2), Math.max(0, width - slot));
				return (
					<Text key={`x${mark.text}${mark.at}`} className="absolute text-caption" numberOfLines={1} style={{ left, width: slot, textAlign: "center", color, top: marks.bounds.bottom + 6 }}>
						{mark.text}
					</Text>
				);
			})}
		</View>
	);
}

type PressState = { isActive: SharedValue<boolean>; matchedIndex: SharedValue<number>; x: { value: { value: unknown } } };
type Touchable = { handleTouch: (state: never, x: number, y: number) => void };

/** Quanto tempo o valor tocado fica na tela depois de um toque rápido. */
export const TAP_HOLD_MS = 2500;

/** Pressão do victory: tocar e segurar (100 ms) arrasta o valor sem brigar com a rolagem vertical. */
export const PRESS_CONFIG = { pan: { activateAfterLongPress: 100 } } as const;

/**
 * Toque rápido mostra o valor: o victory só ativa por segurar, então um `Gesture.Tap` chama o mesmo `handleTouch` do
 * victory (acha o ponto mais próximo pela escala) e esconde sozinho depois de `TAP_HOLD_MS`. Segurar e arrastar segue
 * valendo pela pressão do próprio victory (o Tap perde a corrida se o dedo anda).
 */
export function usePressTap(state: PressState) {
	const actionsRef = useSharedValue<Touchable | null>(null);
	const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const hideLater = React.useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			state.isActive.value = false;
		}, TAP_HOLD_MS);
	}, [state]);
	React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
	const customGestures = React.useMemo(
		() =>
			Gesture.Race(
				Gesture.Tap()
					.maxDuration(250)
					.onEnd((event, success) => {
						"worklet";
						if (!success) return;
						state.isActive.value = true;
						actionsRef.value?.handleTouch(state as never, event.x, event.y);
						scheduleOnRN(hideLater);
					}),
			),
		[state, actionsRef, hideLater],
	);
	return { actionsRef, customGestures };
}

/**
 * Cartão de valor ao tocar, num filho próprio: o índice tocado muda várias vezes por segundo ao arrastar e só este
 * componente re-renderiza (o gráfico, que é pesado, não). `mode`: `matched` = índice do victory; `x` = valor de X arredondado (barras).
 */
export function PressLayer({ state, mode, scheme, contentFor }: { state: PressState; mode: "matched" | "x"; scheme: ColorScheme; contentFor: (index: number) => { title: string; rows: ReadonlyArray<{ color: string; label: string; value: string }> } | null }) {
	const [pressed, setPressed] = React.useState<number | null>(null);
	useAnimatedReaction(
		() => (state.isActive.value ? (mode === "x" ? Math.round(Number(state.x.value.value)) : state.matchedIndex.value) : -1),
		(index, previous) => {
			if (index !== previous) scheduleOnRN(setPressed, index < 0 ? null : index);
		},
	);
	const content = pressed === null ? null : contentFor(pressed);
	return content ? <PressCard scheme={scheme} title={content.title} rows={content.rows} /> : null;
}
