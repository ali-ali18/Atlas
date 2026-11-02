import * as React from "react";
import { PanResponder, View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import {
	distanceBetween,
	doubleTapZoom,
	isDoubleTap,
	isTap,
	midpoint,
	panBy,
	pinchTransform,
	ZOOM_RESET,
	type Point,
	type Size,
	type ZoomState,
} from "@/lib/pinch-zoom";

type Touch = { pageX: number; pageY: number };

/** Dedos na tela como pontos (a API de toque do RN; não precisa de módulo nativo além do que o Expo Go traz). */
function touchPoints(event: GestureResponderEvent): Point[] {
	return (event.nativeEvent.touches as readonly Touch[]).map((t) => ({ x: t.pageX, y: t.pageY }));
}

const DOUBLE_TAP_ANIM_MS = 180;

/**
 * Área com zoom por pinça (1x a 4x), arrastar para mover quando ampliado e duplo toque para alternar 1x/2x.
 * O conteúdo (imagem do computador remoto) tem a largura da tela e a proporção `aspectRatio`, centralizado na vertical.
 * Toda a conta está em `lib/pinch-zoom.ts` (testada); aqui só entram os dedos e a animação.
 */
export function Zoomable({ aspectRatio = 16 / 9, children, onZoomChange }: { aspectRatio?: number; children: React.ReactNode; onZoomChange?: (scale: number) => void }) {
	const [viewport, setViewport] = React.useState<Size>({ width: 0, height: 0 });
	const frame = React.useMemo<Size>(() => ({ width: viewport.width, height: viewport.width / aspectRatio }), [viewport.width, aspectRatio]);
	const scale = useSharedValue(1);
	const x = useSharedValue(0);
	const y = useSharedValue(0);
	const rootRef = React.useRef<React.ComponentRef<typeof View>>(null);
	const origin = React.useRef<Point>({ x: 0, y: 0 });
	const current = React.useRef<ZoomState>(ZOOM_RESET);
	// Último tamanho conhecido, lido pelos handlers do PanResponder (criado uma vez).
	const geometry = React.useRef({ frame, viewport });
	geometry.current = { frame, viewport };
	const onZoom = React.useRef(onZoomChange);
	onZoom.current = onZoomChange;

	const apply = React.useCallback(
		(next: ZoomState, animated = false) => {
			current.current = next;
			if (animated) {
				scale.value = withTiming(next.scale, { duration: DOUBLE_TAP_ANIM_MS });
				x.value = withTiming(next.x, { duration: DOUBLE_TAP_ANIM_MS });
				y.value = withTiming(next.y, { duration: DOUBLE_TAP_ANIM_MS });
			} else {
				scale.value = next.scale;
				x.value = next.x;
				y.value = next.y;
			}
			onZoom.current?.(next.scale);
		},
		[scale, x, y],
	);

	// Ao girar a tela o quadro muda: volta a 1x em vez de deixar o deslocamento fora do limite.
	React.useEffect(() => {
		apply(ZOOM_RESET);
	}, [viewport.width, viewport.height, apply]);

	const responder = React.useMemo(() => {
		// Refeito a cada mudança no número de dedos (pinça começando ou terminando), para não dar salto.
		let base: { state: ZoomState; points: Point[] } = { state: ZOOM_RESET, points: [] };
		let lastTouches = 0;
		let moved = 0;
		let maxTouches = 0;
		let lastTapAt: number | null = null;
		const toCenter = (p: Point): Point => ({ x: p.x - origin.current.x - geometry.current.viewport.width / 2, y: p.y - origin.current.y - geometry.current.viewport.height / 2 });
		const rebase = (points: Point[]) => {
			base = { state: current.current, points };
			lastTouches = points.length;
		};
		return PanResponder.create({
			onStartShouldSetPanResponder: () => true,
			onMoveShouldSetPanResponder: () => true,
			onPanResponderTerminationRequest: () => false,
			onPanResponderGrant: (event) => {
				rootRef.current?.measureInWindow((px, py) => {
					origin.current = { x: px, y: py };
				});
				moved = 0;
				maxTouches = 1;
				rebase(touchPoints(event));
			},
			onPanResponderMove: (event) => {
				const points = touchPoints(event);
				if (points.length === 0) return;
				maxTouches = Math.max(maxTouches, points.length);
				if (points.length !== lastTouches) rebase(points);
				const { frame: f, viewport: v } = geometry.current;
				if (points.length >= 2 && base.points.length >= 2) {
					const [a0, b0] = base.points as [Point, Point];
					const [a1, b1] = points as [Point, Point];
					apply(
						pinchTransform(
							base.state,
							{ distance: distanceBetween(a0, b0), center: toCenter(midpoint(a0, b0)) },
							{ distance: distanceBetween(a1, b1), center: toCenter(midpoint(a1, b1)) },
							f,
							v,
						),
					);
					return;
				}
				const start = base.points[0];
				const now = points[0];
				if (!start || !now) return;
				const dx = now.x - start.x;
				const dy = now.y - start.y;
				moved = Math.max(moved, Math.hypot(dx, dy));
				apply(panBy(base.state, dx, dy, f, v));
			},
			onPanResponderRelease: (event) => {
				// Um dedo só, quase parado = toque; dois toques seguidos alternam 1x/2x em torno do ponto.
				if (maxTouches !== 1 || !isTap(moved, 0)) {
					lastTapAt = null;
					return;
				}
				const now = Date.now();
				if (isDoubleTap(lastTapAt, now)) {
					const at = touchPoints(event)[0] ?? { x: origin.current.x + geometry.current.viewport.width / 2, y: origin.current.y + geometry.current.viewport.height / 2 };
					apply(doubleTapZoom(current.current, toCenter(at), geometry.current.frame, geometry.current.viewport), true);
					lastTapAt = null;
				} else {
					lastTapAt = now;
				}
			},
		});
	}, [apply]);

	const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));
	const onLayout = (event: LayoutChangeEvent) => {
		const { width, height } = event.nativeEvent.layout;
		setViewport((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
	};

	return (
		<View ref={rootRef} onLayout={onLayout} className="flex-1 items-center justify-center overflow-hidden" {...responder.panHandlers}>
			<Animated.View style={[{ width: viewport.width, aspectRatio }, animatedStyle]}>{children}</Animated.View>
		</View>
	);
}
