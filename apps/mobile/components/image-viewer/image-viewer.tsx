import * as React from "react";
import { FlatList, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, Modal, Pressable, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemedModalRoot } from "@/components/home/themed-modal";
import { ChatImageView } from "@/components/chat/chat-image";
import { CloseIcon, DotsIcon, DownloadIcon, ForwardIcon, ShareIcon } from "@/components/icons";
import { ActionSheet, type SheetGroup } from "@/components/ui/action-sheet";
import { ChromeButton } from "@/components/ui/chrome-button";
import { Text } from "@/components/ui/text";
import { IMAGE_NOTICE } from "@/lib/image-actions";
import { clampIndex, fitImage, indexFromOffset, type ViewerImage } from "@/lib/image-viewer";
import { SchemeOverrideContext } from "@/lib/use-theme";
import { useSurfaces } from "@/lib/use-surfaces";
import type { ImageViewerActions } from "./use-image-actions";

/** Lado da miniatura e vão entre elas, em dp. */
const THUMB = 52;
const THUMB_GAP = 8;
/** Respiro lateral da imagem e do rodapé. */
const SIDE = 16;
/** Quanto o aviso curto ("Imagem salva") fica na tela, em ms. */
const NOTICE_MS = 2200;

type Props = { visible: boolean; images: readonly ViewerImage[]; startIndex: number; onClose: () => void; actions: ImageViewerActions };

/**
 * Visualizador de imagens do chat (estilo Grok): tela cheia, fundo preto, a imagem inteira (contain) com cantos arredondados,
 * X redondo à esquerda e "…" à direita (Encaminhar, Compartilhar, Salvar), legenda embaixo e uma tira de miniaturas com
 * todas as imagens da conversa. Deslizar para o lado troca de imagem e a miniatura acompanha; tocar na miniatura também troca.
 * É sempre escuro (`SchemeOverrideContext`), qualquer que seja o tema do sistema.
 */
export function ImageViewer({ visible, images, startIndex, onClose, actions }: Props) {
	return (
		<Modal visible={visible && images.length > 0} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
			<SchemeOverrideContext.Provider value="dark">
				<ThemedModalRoot>
					<ViewerBody images={images} startIndex={clampIndex(startIndex, images.length)} onClose={onClose} actions={actions} />
				</ThemedModalRoot>
			</SchemeOverrideContext.Provider>
		</Modal>
	);
}

function ViewerBody({ images, startIndex, onClose, actions }: Omit<Props, "visible">) {
	const insets = useSafeAreaInsets();
	const surfaces = useSurfaces();
	const { width } = useWindowDimensions();
	const [index, setIndex] = React.useState(startIndex);
	const [pagerHeight, setPagerHeight] = React.useState(0);
	const [menu, setMenu] = React.useState(false);
	const [notice, setNotice] = React.useState<string | null>(null);
	const pager = React.useRef<FlatList<ViewerImage>>(null);
	const thumbs = React.useRef<FlatList<ViewerImage>>(null);
	const noticeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const current = images[index];

	const showNotice = React.useCallback((text: string | null, sticky = false) => {
		if (noticeTimer.current) clearTimeout(noticeTimer.current);
		setNotice(text);
		if (text && !sticky) noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
	}, []);
	React.useEffect(
		() => () => {
			if (noticeTimer.current) clearTimeout(noticeTimer.current);
		},
		[],
	);

	// A miniatura da imagem atual fica sempre visível (centralizada quando dá).
	React.useEffect(() => {
		thumbs.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
	}, [index]);

	const onScroll = React.useCallback(
		(event: NativeSyntheticEvent<NativeScrollEvent>) => {
			setIndex(indexFromOffset(event.nativeEvent.contentOffset.x, width, images.length));
		},
		[width, images.length],
	);
	const goTo = React.useCallback(
		(target: number) => {
			setIndex(target);
			pager.current?.scrollToOffset({ offset: target * width, animated: true });
		},
		[width],
	);

	const run = React.useCallback(
		(action: (image: ViewerImage) => Promise<string | null>, busy?: string) => {
			const image = images[index];
			if (!image) return;
			setMenu(false);
			if (busy) showNotice(busy, true);
			void action(image).then((text) => showNotice(text));
		},
		[images, index, showNotice],
	);
	const groups = React.useMemo<SheetGroup[]>(
		() => [
			[
				{ key: "forward", label: "Encaminhar", icon: <ForwardIcon />, onPress: () => run(actions.forward) },
				{ key: "share", label: "Compartilhar", icon: <ShareIcon size={20} tone="foreground" />, onPress: () => run(actions.share) },
				{ key: "save", label: "Salvar", icon: <DownloadIcon />, onPress: () => run(actions.save, IMAGE_NOTICE.saving) },
			],
		],
		[actions, run],
	);

	const pageHeight = pagerHeight;
	const box = { width: width - SIDE * 2, height: Math.max(pageHeight - 8, 0) };
	const onPagerLayout = (event: LayoutChangeEvent) => setPagerHeight(event.nativeEvent.layout.height);

	return (
		<View className="flex-1 bg-black" style={{ paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 12) }}>
			<View className="flex-row items-center justify-between" style={{ paddingHorizontal: SIDE }}>
				<ChromeButton label="Fechar" onPress={onClose}>
					<CloseIcon size={20} tone="foreground" />
				</ChromeButton>
				<ChromeButton label="Mais opções" onPress={() => setMenu(true)}>
					<DotsIcon size={22} tone="foreground" />
				</ChromeButton>
			</View>

			<View className="flex-1" onLayout={onPagerLayout}>
				{pageHeight > 0 ? (
					<FlatList
						ref={pager}
						data={images as ViewerImage[]}
						keyExtractor={(image) => image.key}
						horizontal
						pagingEnabled
						showsHorizontalScrollIndicator={false}
						initialScrollIndex={startIndex}
						getItemLayout={(_, at) => ({ length: width, offset: width * at, index: at })}
						scrollEventThrottle={16}
						onScroll={onScroll}
						extraData={`${width}x${pageHeight}`}
						renderItem={({ item }) => {
							const fitted = fitImage(item.width, item.height, box.width, box.height);
							return (
								<View style={{ width, height: pageHeight }} className="items-center justify-center">
									<ChatImageView image={item} resizeMode="contain" tone="plain" style={{ width: fitted.width, height: fitted.height, borderRadius: 20 }} />
								</View>
							);
						}}
					/>
				) : null}
			</View>

			<View className="items-center justify-center" style={{ minHeight: 48, paddingHorizontal: 24, paddingVertical: 8 }}>
				{current?.caption ? (
					<Text numberOfLines={2} className="text-center text-control text-muted-foreground">
						{current.caption}
					</Text>
				) : null}
			</View>

			{images.length > 1 ? (
				<FlatList
					ref={thumbs}
					data={images as ViewerImage[]}
					keyExtractor={(image) => image.key}
					horizontal
					showsHorizontalScrollIndicator={false}
					style={{ flexGrow: 0 }}
					contentContainerStyle={{ paddingHorizontal: SIDE, gap: THUMB_GAP, alignItems: "center" }}
					getItemLayout={(_, at) => ({ length: THUMB, offset: (THUMB + THUMB_GAP) * at, index: at })}
					initialScrollIndex={startIndex}
					onScrollToIndexFailed={() => undefined}
					renderItem={({ item, index: at }) => {
						const active = at === index;
						return (
							<Pressable
								role="button"
								accessibilityLabel={`Ver imagem ${at + 1} de ${images.length}`}
								accessibilityState={{ selected: active }}
								onPress={() => goTo(at)}
								style={{ width: THUMB, height: THUMB, opacity: active ? 1 : 0.55 }}
								className={active ? "rounded-xl border-2 border-foreground p-0.5" : "rounded-xl border border-transparent"}
							>
								<ChatImageView image={item} style={{ width: "100%", height: "100%", borderRadius: active ? 8 : 10 }} />
							</Pressable>
						);
					}}
				/>
			) : null}

			{notice ? (
				<View pointerEvents="none" className="absolute inset-x-0 items-center" style={{ bottom: insets.bottom + (images.length > 1 ? THUMB + 76 : 76) }}>
					<View accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ backgroundColor: surfaces.chromeFill, borderColor: surfaces.chromeEdge }} className="max-w-[86%] rounded-full border px-4 py-2.5">
						<Text className="text-center text-control">{notice}</Text>
					</View>
				</View>
			) : null}

			<ActionSheet visible={menu} onClose={() => setMenu(false)} groups={groups} />
		</View>
	);
}
