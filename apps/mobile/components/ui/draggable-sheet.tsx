import * as React from "react";
import { type AccessibilityActionEvent, Modal, PanResponder, Pressable, type RefreshControlProps, ScrollView, useWindowDimensions, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemedModalRoot } from "@/components/home/themed-modal";
import { useKeyboardHeight } from "@/lib/use-keyboard-visible";
import { useSurfaces } from "@/lib/use-surfaces";
import { dragHeight, normalizeRest, restHeight, settleSheet, type SheetRest, tapRest } from "@/lib/sheet-drag";

/** Folga entre o topo da gaveta expandida e a barra de status. */
const TOP_GAP = 16;
/** Folha de conteúdo: um pouco mais de folga, para a conversa aparecer numa faixa legível no topo. */
const TOP_GAP_FULL = 40;
/** A gaveta abre, no máximo, com 60% da tela. */
const COLLAPSED_MAX = 0.6;
const ANIMATION_MS = 220;
const SLIDE_MS = 280;
/** Deslocamento (pt) abaixo do qual o gesto na alça conta como toque. */
const TAP_SLOP = 4;

type Props = {
	visible: boolean;
	onClose: () => void;
	/** Voltar do Android. Padrão: fechar. (O menu usa para voltar de um submenu.) */
	onRequestClose?: () => void;
	/** Faixa fixa abaixo da alça que também arrasta (título, "voltar"). O conteúdo do corpo não arrasta, para não brigar com a rolagem. */
	header?: React.ReactNode;
	/** Folha de conteúdo (painel, documento): abre quase na tela toda e arrastar para baixo fecha (não há altura intermediária). */
	fullHeight?: boolean;
	/** Cor de fundo da folha (padrão: `popover`). */
	backgroundColor?: string;
	/** Margem lateral do corpo (padrão 16). */
	bodyPadding?: number;
	/** Puxar para atualizar no corpo (a folha de conteúdo usa; o menu não). */
	refreshControl?: React.ReactElement<RefreshControlProps>;
	/** Faixa fixa logo abaixo do cabeçalho (ex.: campo de busca): não arrasta nem rola com o corpo. */
	fixed?: React.ReactNode;
	children: React.ReactNode;
};

/**
 * Gaveta de baixo ARRASTÁVEL, como a do Grok: abre na altura do conteúdo (até 60% da tela), a alça e o cabeçalho
 * puxam para cima até perto do topo (topo seguro + 16 pt) e para baixo de volta; puxar para baixo a partir da altura
 * inicial (distância ou arremesso) fecha. Toque no fundo escuro fecha. O corpo é um `ScrollView`.
 * O gesto é do `PanResponder` do RN só na alça e no cabeçalho; a decisão (onde assenta) é pura, em `lib/sheet-drag.ts`.
 */
export function DraggableSheet({ visible, onClose, onRequestClose, header, fixed, fullHeight = false, backgroundColor, bodyPadding = 16, refreshControl, children }: Props) {
	const insets = useSafeAreaInsets();
	const surfaces = useSurfaces();
	const { height: screenHeight } = useWindowDimensions();
	const reducedMotion = useReducedMotion();
	// Com o teclado aberto a gaveta sobe junto: a altura útil é a tela menos o teclado.
	const keyboard = useKeyboardHeight();
	const expandedHeight = Math.max(0, screenHeight - insets.top - (fullHeight ? TOP_GAP_FULL : TOP_GAP) - keyboard);
	const [zoneHeight, setZoneHeight] = React.useState(0);
	const [contentHeight, setContentHeight] = React.useState(0);
	const [rest, setRest] = React.useState<SheetRest>("collapsed");
	const measured = zoneHeight > 0 && contentHeight > 0;
	// Antes de medir (ou se o Android nunca medir) a gaveta já aparece com esta altura: nunca fica invisível esperando `onLayout`.
	// `fullHeight`: a altura inicial já é a máxima, então só existem "aberta" e "fechada" (arrastar para baixo fecha).
	const fallbackHeight = fullHeight ? expandedHeight : Math.min(Math.round(screenHeight * COLLAPSED_MAX), expandedHeight || Infinity);
	const collapsedHeight = fullHeight ? expandedHeight : measured ? Math.min(zoneHeight + contentHeight, fallbackHeight) : fallbackHeight;
	const [grace, setGrace] = React.useState(false);
	const height = useSharedValue(0);
	// 1 = gaveta toda fora da tela (embaixo), 0 = no lugar: a abertura sobe de baixo, não aparece no meio.
	const slide = useSharedValue(1);
	const placed = React.useRef(false);
	const shown = measured || grace;

	// O gesto roda fora do render: lê sempre os valores atuais por ref.
	const live = React.useRef({ rest, collapsed: collapsedHeight, expanded: expandedHeight, onClose, reduced: reducedMotion });
	live.current = { rest, collapsed: collapsedHeight, expanded: expandedHeight, onClose, reduced: reducedMotion };

	const animateTo = React.useCallback(
		(target: number) => {
			height.value = live.current.reduced ? target : withTiming(target, { duration: ANIMATION_MS, easing: Easing.out(Easing.cubic) });
		},
		[height],
	);

	// Fechou: a próxima abertura volta colapsada, do zero.
	React.useEffect(() => {
		if (visible) return;
		height.value = 0;
		slide.value = 1;
		placed.current = false;
		setRest("collapsed");
		setContentHeight(0);
		setGrace(false);
	}, [visible, height, slide]);

	// Sem medida: mostra já na altura padrão e libera a opacidade depois de um instante, aconteça o que acontecer com o layout.
	React.useEffect(() => {
		if (!visible || measured) return;
		height.value = fallbackHeight;
		const timer = setTimeout(() => setGrace(true), 250);
		return () => clearTimeout(timer);
	}, [visible, measured, fallbackHeight, height]);

	// Abriu, o conteúdo mudou (submenu) ou a tela girou: acomoda na altura do estado atual.
	React.useEffect(() => {
		if (!visible || !measured) return;
		const target = restHeight(rest, { collapsed: collapsedHeight, expanded: expandedHeight });
		// Primeira medida: assenta direto na altura certa (sem encolher); a entrada é a subida de `slide`.
		if (placed.current) animateTo(target);
		else height.value = target;
		placed.current = true;
	}, [visible, measured, rest, collapsedHeight, expandedHeight, animateTo, height]);

	// A gaveta sobe de baixo assim que está visível.
	React.useEffect(() => {
		if (!visible || !shown) return;
		slide.value = live.current.reduced ? 0 : withTiming(0, { duration: SLIDE_MS, easing: Easing.out(Easing.cubic) });
	}, [visible, shown, slide]);

	const settle = React.useCallback(
		(next: "closed" | SheetRest, target: number) => {
			if (next === "closed") {
				animateTo(0);
				live.current.onClose();
				return;
			}
			// Altura única (folha de conteúdo): o repouso é sempre "collapsed", para o arremesso seguinte fechar.
			setRest(normalizeRest(next, { collapsed: live.current.collapsed, expanded: live.current.expanded }));
			animateTo(target);
		},
		[animateTo],
	);

	const pan = React.useMemo(() => {
		let from: SheetRest = "collapsed";
		const heights = () => ({ collapsed: live.current.collapsed, expanded: live.current.expanded });
		return PanResponder.create({
			onStartShouldSetPanResponder: () => true,
			onPanResponderTerminationRequest: () => false,
			onPanResponderGrant: () => {
				from = live.current.rest;
			},
			onPanResponderMove: (_event, g) => {
				height.value = dragHeight(from, g.dy, heights());
			},
			onPanResponderRelease: (_event, g) => {
				if (Math.abs(g.dy) < TAP_SLOP && Math.abs(g.dx) < TAP_SLOP) {
					// Toque na alça alterna entre as duas alturas.
					const next = tapRest(from, heights());
					settle(next, restHeight(next, heights()));
					return;
				}
				const result = settleSheet(from, g.dy, g.vy, heights());
				settle(result.next, result.height);
			},
			onPanResponderTerminate: () => {
				settle(from, restHeight(from, heights()));
			},
		});
	}, [height, settle]);

	const sheetStyle = useAnimatedStyle(() => ({ height: height.value, transform: [{ translateY: slide.value * height.value }] }));

	const onAccessibilityAction = (event: AccessibilityActionEvent) => {
		const heights = { collapsed: collapsedHeight, expanded: expandedHeight };
		if (event.nativeEvent.actionName === "expand") settle("expanded", restHeight("expanded", heights));
		// Folha de altura cheia não tem "recolher": a ação equivalente é fechar.
		else if (event.nativeEvent.actionName === "collapse") {
			if (fullHeight) settle("closed", 0);
			else settle("collapsed", restHeight("collapsed", heights));
		}
		else if (event.nativeEvent.actionName === "dismiss") settle("closed", 0);
	};

	const bodyRoom = restHeight(rest, { collapsed: collapsedHeight, expanded: expandedHeight }) - zoneHeight;
	// Sem medida (Android que nunca avisa o tamanho) o corpo rola, para o texto longo não ficar preso.
	const scrolls = !measured || contentHeight > bodyRoom;

	return (
		<Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose ?? onClose} statusBarTranslucent>
			<ThemedModalRoot>
				<Pressable accessibilityLabel="Fechar" onPress={onClose} className="absolute inset-0 bg-black/50" />
				<View pointerEvents="box-none" className="flex-1 justify-end" style={{ paddingBottom: keyboard }}>
					<Animated.View style={[{ opacity: shown ? 1 : 0 }, sheetStyle]}>
						<View className="flex-1 overflow-hidden rounded-t-panel" style={{ backgroundColor: backgroundColor ?? surfaces.sheet }}>
							<View onLayout={(event) => setZoneHeight(event.nativeEvent.layout.height)}>
							<View {...pan.panHandlers}>
								<View
									accessible
									accessibilityRole="adjustable"
									accessibilityLabel={fullHeight ? "Arraste para baixo para fechar" : rest === "expanded" ? "Arraste para baixo para recolher" : "Arraste para cima para expandir"}
									accessibilityActions={[
										{ name: "expand", label: "Expandir" },
										{ name: "collapse", label: "Recolher" },
										{ name: "dismiss", label: "Fechar" },
									]}
									onAccessibilityAction={onAccessibilityAction}
									className="h-8 items-center justify-center"
								>
									<View className="h-1 w-10 rounded-full bg-muted-foreground/40" />
								</View>
								{header ? <View className="pb-2" style={{ paddingHorizontal: bodyPadding }}>{header}</View> : null}
							</View>
							{fixed ? <View className="px-4 pb-2">{fixed}</View> : null}
							</View>
							<ScrollView
								refreshControl={refreshControl}
								scrollEnabled={scrolls || refreshControl !== undefined}
								showsVerticalScrollIndicator={scrolls}
								onContentSizeChange={(_w, h) => setContentHeight(h)}
								contentContainerStyle={{ paddingHorizontal: bodyPadding, paddingBottom: insets.bottom + 16, gap: 16 }}
							>
								{children}
							</ScrollView>
						</View>
					</Animated.View>
				</View>
			</ThemedModalRoot>
		</Modal>
	);
}
