import * as React from "react";
import { Pressable, View } from "react-native";
import { LibraryIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import type { ChatImage, ChatItem } from "@/lib/chat-types";
import { FAN_ROTATIONS, fanImages, imagesCountLabel, shortCaption, singleImageAspect } from "@/lib/image-viewer";
import { useSurfaces } from "@/lib/use-surfaces";
import { ChatImageView } from "./chat-image";

type ImagesItem = Extract<ChatItem, { kind: "images" }>;

/** Largura da imagem da frente (e da única), em dp, e o teto de altura para fotos em pé. */
const FRONT_WIDTH = 250;
const FRONT_MAX_HEIGHT = 320;
const RADIUS = 20;
/** Quanto cada carta de trás avança para o lado de fora, para aparecer a borda dela. */
const FAN_SHIFT = 14;
/** Folga em cima: as cartas giradas sobem um pouco acima da imagem da frente. */
const FAN_LIFT = 14;

/** Altura da imagem da frente: pela proporção dela, com teto. */
function frontHeight(image: ChatImage): number {
	return Math.min(Math.round(FRONT_WIDTH / singleImageAspect(image.width, image.height)), FRONT_MAX_HEIGHT);
}

/**
 * Imagens no fio: do usuário (anexo, à direita) ou do bot (à esquerda). Uma imagem aparece grande, na proporção dela;
 * várias viram um leque de cartas (a primeira inteira na frente, até 2 giradas atrás) com "N imagens" embaixo. Tocar no
 * leque ou no texto abre o visualizador na primeira imagem. Sem cartão em volta; a legenda, quando há, fica embaixo.
 */
export function ImagesRow({ item, onOpen }: { item: ImagesItem; onOpen: (artifactId: string) => void }) {
	const surfaces = useSurfaces();
	const fan = fanImages(item.images);
	if (!fan) return null;
	const mine = item.origin === "user";
	const side = mine ? "self-end" : "self-start";
	const caption = shortCaption(item.caption);
	const count = item.images.length;
	const { front, behind } = fan;
	const height = frontHeight(front);
	// Imagem do usuário à direita: as cartas de trás saem para a esquerda (leque espelhado); a do bot, para a direita.
	const direction = mine ? -1 : 1;
	const frame = { borderRadius: RADIUS, borderWidth: 1, borderColor: surfaces.chromeEdge } as const;

	if (count === 1) {
		return (
			<View className={`max-w-[87%] gap-1.5 ${side}`}>
				<Pressable role="button" accessibilityLabel={front.alt ? `Abrir imagem: ${front.alt}` : "Abrir imagem"} onPress={() => onOpen(front.artifactId)} className="active:opacity-80">
					<ChatImageView image={front} style={{ width: FRONT_WIDTH, height, ...frame }} />
				</Pressable>
				{caption ? (
					<Text variant="caption" className="px-1 text-body">
						{caption}
					</Text>
				) : null}
			</View>
		);
	}

	const spread = behind.length * FAN_SHIFT;
	return (
		<View className={`max-w-[87%] gap-2 ${side}`}>
			<Pressable role="button" accessibilityLabel={`Abrir ${imagesCountLabel(count)}`} onPress={() => onOpen(front.artifactId)} className="gap-2 active:opacity-80">
				<View style={{ width: FRONT_WIDTH + spread, height: height + FAN_LIFT + 6 }}>
					{[...behind].reverse().map((image, reversed) => {
						const depth = behind.length - 1 - reversed;
						const shift = (depth + 1) * FAN_SHIFT * direction;
						return (
							<View
								key={`${image.artifactId}-${depth}`}
								pointerEvents="none"
								style={{ position: "absolute", top: FAN_LIFT, [mine ? "right" : "left"]: 0, transform: [{ translateX: shift }, { rotate: `${(FAN_ROTATIONS[depth] ?? 8) * direction}deg` }] }}
							>
								<ChatImageView image={image} style={{ width: FRONT_WIDTH, height, ...frame }} />
							</View>
						);
					})}
					<View style={{ position: "absolute", top: FAN_LIFT, [mine ? "right" : "left"]: 0 }}>
						<ChatImageView image={front} style={{ width: FRONT_WIDTH, height, ...frame }} />
					</View>
				</View>
				<View className="flex-row items-center gap-1.5 px-1" style={{ alignSelf: mine ? "flex-end" : "flex-start" }}>
					<LibraryIcon size={14} />
					<Text variant="caption" className="text-muted-foreground">
						{imagesCountLabel(count)}
					</Text>
				</View>
			</Pressable>
			{caption ? (
				<Text variant="caption" className="px-1 text-body">
					{caption}
				</Text>
			) : null}
		</View>
	);
}
