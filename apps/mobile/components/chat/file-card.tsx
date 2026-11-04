import { Pressable, View } from "react-native";
import { ChatCard } from "@/components/ui/chat-card";
import { FileTile } from "@/components/ui/file-tile";
import { Text } from "@/components/ui/text";
import type { ChatItem } from "@/lib/chat-types";
import { BUBBLE_MAX_WIDTH_CLASS } from "@/lib/bubble-corners";
import { chatCardSkin } from "@/lib/chat-surface";
import { useAppColorScheme } from "@/lib/use-theme";
import { fileCardKind, fileCardSubtitle, fileCardTitle } from "@/lib/file-card";
import { viewerTargetForCard } from "@/lib/viewer-target";

type WebCard = Extract<ChatItem, { kind: "web-card" }>;

/**
 * Cartão de arquivo/documento no fio, na casca `ChatCard` com as medidas do "Criar agente" (`bot-cards.tsx`): `p-4`,
 * largura máxima do balão do bot (`BUBBLE_MAX_WIDTH_CLASS`), `chatCardSkin`, nome `text-base`. Ícone com faixa do tipo, nome (sem extensão) em destaque
 * e, embaixo, "PDF · 1,6 KB". Toque abre a folha do documento (com `fileId`) ou, sem ele, o navegador.
 */
export function FileCardRow({ item, onOpen, onOpenPage }: { item: WebCard; onOpen: (item: WebCard) => void; onOpenPage?: (item: WebCard) => void }) {
	const scheme = useAppColorScheme();
	const target = viewerTargetForCard(item);
	const native = onOpenPage && target ? onOpenPage : null;
	const kind = fileCardKind(item.title, item.mime);
	const subtitle = fileCardSubtitle(item.title, item.mime, item.size);
	return (
		<Pressable
			role="button"
			accessibilityLabel={`${item.title}. ${subtitle}. ${native ? "Abrir documento" : "Abrir no navegador"}`}
			onPress={() => (native ? native(item) : onOpen(item))}
			className={`min-w-56 self-start active:opacity-80 ${BUBBLE_MAX_WIDTH_CLASS}`}
		>
			<ChatCard className="flex-row items-center gap-3 px-4 py-3" style={chatCardSkin(scheme)}>
				<FileTile glyph={kind.glyph} tone={kind.tone} />
				<View className="min-w-0 flex-1 gap-0.5">
					<Text numberOfLines={2} className="text-base font-medium">
						{fileCardTitle(item.title)}
					</Text>
					<Text variant="muted" numberOfLines={1} className="text-body">
						{subtitle}
					</Text>
				</View>
			</ChatCard>
		</Pressable>
	);
}
