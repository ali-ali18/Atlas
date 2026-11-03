import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { Platform, ScrollView, Text as RNText, View } from "react-native";
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { SendIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { SurfaceCard } from "@/components/ui/surface-card";
import { surfaceColors } from "@/lib/surfaces";
import { useSurfaces } from "@/lib/use-surfaces";
import { cn } from "@/lib/cn";
import { parseMarkdown, tableColumnWidths, type Block, type Inline } from "@/lib/markdown";
import { themeColor } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });

/**
 * Toque longo SEM disputar o gesto: um `Pressable` em volta da tabela pegava o toque e a rolagem para o lado só pegava
 * num ponto específico. Aqui só se observam os toques (nada de responder): passou de 500 ms parado, é toque longo;
 * mexeu mais de 8 pt ou soltou antes, cancela. O ScrollView fica sozinho com o arraste.
 */
function useTouchLongPress(onLongPress: (() => void) | undefined) {
	const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const origin = React.useRef({ x: 0, y: 0 });
	const clear = React.useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	}, []);
	React.useEffect(() => clear, [clear]);
	if (!onLongPress) return {};
	return {
		onTouchStart: (event: { nativeEvent: { pageX: number; pageY: number } }) => {
			clear();
			origin.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
			timer.current = setTimeout(() => {
				timer.current = null;
				onLongPress();
			}, 500);
		},
		onTouchMove: (event: { nativeEvent: { pageX: number; pageY: number } }) => {
			if (Math.abs(event.nativeEvent.pageX - origin.current.x) > 8 || Math.abs(event.nativeEvent.pageY - origin.current.y) > 8) clear();
		},
		onTouchEnd: clear,
		onTouchCancel: clear,
	};
}

/** Largura do trilho da barrinha de rolagem (dp), medida no app do Grok. */
const TRACK_WIDTH = 29;

function openLink(url: string) {
	void WebBrowser.openBrowserAsync(url).catch(() => undefined);
}

/** `plainCode`: código sem fundo nem espaços ao redor (dentro da tabela do Grok o código é só mono, 15 pt). */
function Inlines({ nodes, scheme, plainCode = false }: { nodes: readonly Inline[]; scheme: "light" | "dark"; plainCode?: boolean }) {
	const info = themeColor(scheme, "info");
	return (
		<>
			{nodes.map((node, index) => {
				const key = `${index}-${node.type}`;
				switch (node.type) {
					case "text":
						return node.text;
					case "bold":
						return (
							<RNText key={key} style={{ fontWeight: "700" }}>
								<Inlines nodes={node.children} scheme={scheme} plainCode={plainCode} />
							</RNText>
						);
					case "italic":
						return (
							<RNText key={key} style={{ fontStyle: "italic" }}>
								<Inlines nodes={node.children} scheme={scheme} plainCode={plainCode} />
							</RNText>
						);
					case "code":
						return (
							<RNText key={key} style={plainCode ? { fontFamily: MONO, fontSize: 15 } : { fontFamily: MONO, fontSize: 14, backgroundColor: themeColor(scheme, "secondary") }}>
								{plainCode ? node.text : ` ${node.text} `}
							</RNText>
						);
					case "link":
						// Link e referência a documento aparecem com o ícone azul de link, como na referência do dono.
						// (No celular o ícone é uma view em linha dentro do texto; na prévia web um <svg> quebraria a linha, então lá vai um glifo.)
						return (
							<RNText key={key} accessibilityRole="link" onPress={() => openLink(node.url)} style={{ color: info }}>
								{Platform.OS === "web" ? "➤ " : <SendIcon size={16} tone="info" />} {node.text}
							</RNText>
						);
				}
			})}
		</>
	);
}

/**
 * Tabela como no Grok: um cartão único (a tabela inteira é o balão, sem balão por fora), rola para o lado com a
 * barrinha de rolagem no canto. Larguras explícitas por coluna (`tableColumnWidths`): no Android um ScrollView
 * horizontal sem tamanho definido esticava as linhas até a altura da tela (cartão gigante e vazio).
 */
export function TableCard({ block, scheme, onLongPress }: { block: Extract<Block, { type: "table" }>; scheme: "light" | "dark"; onLongPress?: () => void }) {
	const press = useTouchLongPress(onLongPress);
	const widths = tableColumnWidths(block.header, block.rows);
	const total = widths.reduce((sum, width) => sum + width, 0);
	const [viewport, setViewport] = React.useState(0);
	// A posição da rolagem vive num valor compartilhado (thread de UI): atualizar a barrinha não re-renderiza a tabela,
	// que travava ao puxar quando cada evento de rolagem refazia o cartão inteiro.
	const offset = useSharedValue(0);
	const onScroll = useAnimatedScrollHandler((event) => {
		offset.value = event.contentOffset.x;
	});
	// Cartão e divisor são os padrão do app (lib/surfaces.ts), os mesmos do perfil e das rotinas.
	const { divider } = surfaceColors(scheme);
	const overflow = viewport > 0 && total > viewport;
	return (
		<SurfaceCard className="self-stretch overflow-hidden" {...press}>
			<Animated.ScrollView
				horizontal
				nestedScrollEnabled
				showsHorizontalScrollIndicator={false}
				scrollEventThrottle={16}
				onLayout={(event) => setViewport(event.nativeEvent.layout.width)}
				onScroll={onScroll}
				style={{ flexGrow: 0 }}
				contentContainerStyle={{ flexGrow: 0 }}
			>
				<View style={{ width: Math.max(total, viewport) }}>
					{[block.header, ...block.rows].map((row, rowIndex) => (
						<View key={`row-${rowIndex}`} style={{ flexDirection: "row", borderTopWidth: rowIndex > 0 ? 1 : 0, borderTopColor: divider }}>
							{row.map((cell, column) => (
								<View key={`cell-${column}`} style={{ width: widths[column], paddingHorizontal: 18.5, paddingVertical: 11.5 }}>
									<Text className={cn("text-base leading-snug", rowIndex === 0 && "font-semibold")}>
										<Inlines nodes={cell} scheme={scheme} plainCode />
									</Text>
								</View>
							))}
						</View>
					))}
				</View>
			</Animated.ScrollView>
			{overflow ? <ScrollThumb viewport={viewport} content={total} offset={offset} /> : null}
		</SurfaceCard>
	);
}

/** Barrinha de rolagem do cartão: trilho 29x4 dp no canto de baixo à direita (16 da borda, 3 do fundo), polegar na posição da rolagem. */
function ScrollThumb({ viewport, content, offset }: { viewport: number; content: number; offset: { value: number } }) {
	const surfaces = useSurfaces();
	const thumb = Math.max(12, Math.round(TRACK_WIDTH * (viewport / content)));
	const range = Math.max(1, content - viewport);
	const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: (TRACK_WIDTH - thumb) * Math.min(1, Math.max(0, offset.value / range)) }] }));
	return (
		<View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", right: 16, bottom: 3, width: TRACK_WIDTH, height: 4, borderRadius: 2, backgroundColor: surfaces.divider }}>
			<Animated.View style={[{ position: "absolute", left: 0, width: thumb, height: 4, borderRadius: 2, backgroundColor: surfaces.chromeEdge }, thumbStyle]} />
		</View>
	);
}

function BlockView({ block, scheme }: { block: Block; scheme: "light" | "dark" }) {
	switch (block.type) {
		case "paragraph":
			return (
				<Text className="text-base leading-snug">
					<Inlines nodes={block.inline} scheme={scheme} />
				</Text>
			);
		case "heading":
			return (
				<Text className={cn("font-semibold leading-snug", block.level === 1 ? "text-xl leading-7" : block.level === 2 ? "text-lg leading-7" : "text-base")}>
					<Inlines nodes={block.inline} scheme={scheme} />
				</Text>
			);
		case "list":
			return (
				<View className="gap-1.5">
					{block.items.map((item, index) => (
						<View key={`${index}-${block.ordered}`} className="flex-row gap-2.5 pl-1">
							<Text variant="muted" className="w-5 text-base leading-snug">
								{block.ordered ? `${block.start + index}.` : "•"}
							</Text>
							{/*
							  `shrink`, não `flex-1`: o balão do bot se ajusta ao conteúdo (self-start), e no Android um `flex-1`
							  dentro dele mede largura 0. O texto da lista sumia e o balão virava uma coluna alta só com "1."
							*/}
							<Text className="min-w-0 shrink text-base leading-snug">
								<Inlines nodes={item} scheme={scheme} />
							</Text>
						</View>
					))}
				</View>
			);
		case "code":
			return (
				// Rola na horizontal dentro do balão (largura do balão, sem estourar nem cortar a linha).
				<View className="self-stretch overflow-hidden rounded-card bg-secondary">
					<ScrollView horizontal nestedScrollEnabled style={{ width: "100%" }} contentContainerStyle={{ padding: 12, minWidth: "100%" }}>
						<RNText style={{ fontFamily: MONO, fontSize: 13, lineHeight: 19, color: themeColor(scheme, "foreground") }}>
							{block.text}
						</RNText>
					</ScrollView>
				</View>
			);
		case "quote":
			return (
				<View className="border-l-2 border-border pl-3">
					<Text variant="muted" className="text-base leading-snug">
						<Inlines nodes={block.inline} scheme={scheme} />
					</Text>
				</View>
			);
		case "table":
			return <TableCard block={block} scheme={scheme} />;
		case "rule":
			return <View className="h-px bg-border" />;
	}
}

/** Blocos já separados (parágrafos, listas, código…) um sobre o outro, para o balão. */
export function MarkdownBlocks({ blocks }: { blocks: readonly Block[] }) {
	const scheme = useAppColorScheme();
	return (
		<View className="gap-3">
			{blocks.map((block, index) => (
				<BlockView key={`${index}-${block.type}`} block={block} scheme={scheme} />
			))}
		</View>
	);
}

/** Fala do bot em markdown: negrito, listas, `código` inline, bloco de código, citação e links. */
export const MarkdownText = React.memo(function MarkdownText({ source }: { source: string }) {
	const scheme = useAppColorScheme();
	const blocks = React.useMemo(() => parseMarkdown(source), [source]);
	return (
		<View className="gap-3">
			{blocks.map((block, index) => (
				<BlockView key={`${index}-${block.type}`} block={block} scheme={scheme} />
			))}
		</View>
	);
});
