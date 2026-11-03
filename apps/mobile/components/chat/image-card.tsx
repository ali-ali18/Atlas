import * as React from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import type { ChatItem } from "@/lib/chat-types";
import { imageGridColumns, shortCaption, singleImageAspect } from "@/lib/image-viewer";
import { ChatImageView } from "./chat-image";

type ImagesItem = Extract<ChatItem, { kind: "images" }>;

/** Lado do quadrado na grade (várias imagens) e largura da imagem única, em dp. */
const TILE = 112;
const SINGLE_WIDTH = 248;
const GAP = 4;

/**
 * Imagens no fio: do usuário (anexo, à direita) ou do bot (à esquerda). Uma imagem aparece grande, na proporção dela;
 * várias, numa grade de quadrados. Tocar abre o visualizador na imagem tocada. Sem cartão em volta: só a imagem
 * arredondada e a legenda embaixo, quando há.
 */
export function ImagesRow({ item, onOpen }: { item: ImagesItem; onOpen: (artifactId: string) => void }) {
	const { images } = item;
	const columns = imageGridColumns(images.length);
	const single = images.length === 1 ? images[0] : undefined;
	const side = item.origin === "user" ? "self-end" : "self-start";
	const caption = shortCaption(item.caption);
	return (
		<View className={`max-w-[87%] gap-1.5 ${side}`}>
			{single ? (
				<Pressable role="button" accessibilityLabel={single.alt ? `Abrir imagem: ${single.alt}` : "Abrir imagem"} onPress={() => onOpen(single.artifactId)} className="active:opacity-80">
					<ChatImageView image={single} style={{ width: SINGLE_WIDTH, aspectRatio: singleImageAspect(single.width, single.height), borderRadius: 20 }} />
				</Pressable>
			) : (
				<View className="flex-row flex-wrap" style={{ width: columns * TILE + (columns - 1) * GAP, gap: GAP }}>
					{images.map((image, index) => (
						<Pressable key={`${image.artifactId}-${index}`} role="button" accessibilityLabel={`Abrir imagem ${index + 1} de ${images.length}`} onPress={() => onOpen(image.artifactId)} className="active:opacity-80">
							<ChatImageView image={image} style={{ width: TILE, height: TILE, borderRadius: 14 }} />
						</Pressable>
					))}
				</View>
			)}
			{caption ? (
				<Text variant="caption" className="px-1 text-body">
					{caption}
				</Text>
			) : null}
		</View>
	);
}
