import { Pressable, View } from "react-native";
import { ChatCard } from "@/components/ui/chat-card";
import { FileTile } from "@/components/ui/file-tile";
import { Text } from "@/components/ui/text";
import type { ChatItem } from "@/lib/chat-types";
import { fileCardKind, fileCardSubtitle, fileCardTitle } from "@/lib/file-card";
import { viewerTargetForCard } from "@/lib/viewer-target";

type WebCard = Extract<ChatItem, { kind: "web-card" }>;

/**
 * Cartão de arquivo/documento no fio, na casca `ChatCard` (variante `card`, larga como o balão do bot): ícone com faixa do tipo, nome (sem
 * extensão) em destaque e, embaixo, "PDF · 1,6 KB". Toque abre a folha do documento (com `fileId`) ou, sem ele, o navegador.
 */
export function FileCardRow({ item, onOpen, onOpenPage }: { item: WebCard; onOpen: (item: WebCard) => void; onOpenPage?: (item: WebCard) => void }) {
	const target = viewerTargetForCard(item);
	const native = onOpenPage && target ? onOpenPage : null;
	const kind = fileCardKind(item.title, item.mime);
	const subtitle = fileCardSubtitle(item.title, item.mime, item.size);
	return (
		<Pressable
			role="button"
			accessibilityLabel={`${item.title}. ${subtitle}. ${native ? "Abrir documento" : "Abrir no navegador"}`}
			onPress={() => (native ? native(item) : onOpen(item))}
			className="w-[87%] self-start active:opacity-80"
		>
			<ChatCard variant="card" className="flex-row items-center gap-4 p-4">
				<FileTile glyph={kind.glyph} tone={kind.tone} />
				<View className="min-w-0 flex-1 gap-1">
					<Text numberOfLines={2} className="text-base font-semibold">
						{fileCardTitle(item.title)}
					</Text>
					<Text variant="muted" numberOfLines={1} className="text-sm">
						{subtitle}
					</Text>
				</View>
			</ChatCard>
		</Pressable>
	);
}
