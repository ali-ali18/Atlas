import { Pressable } from "react-native";
import { ExternalLinkIcon, LibraryIcon } from "@/components/icons";
import { ChatCard, ChatCardLine } from "@/components/ui/chat-card";
import { Text } from "@/components/ui/text";
import type { ChatItem } from "@/lib/chat-types";
import { viewerTargetForCard } from "@/lib/viewer-target";

type WebCard = Extract<ChatItem, { kind: "web-card" }>;

/** Cartão de arquivo/documento no fio: toque abre a folha do documento (com `fileId`) ou, sem ele, o navegador. */
export function FileCardRow({ item, onOpen, onOpenPage }: { item: WebCard; onOpen: (item: WebCard) => void; onOpenPage?: (item: WebCard) => void }) {
	const target = viewerTargetForCard(item);
	const native = onOpenPage && target ? onOpenPage : null;
	const nativeLabel = "Abrir documento";
	return (
		<Pressable
			role="button"
			accessibilityLabel={native ? `${item.title}. ${nativeLabel}` : `${item.title}. Abrir no navegador`}
			onPress={() => (native ? native(item) : onOpen(item))}
			className="self-start active:opacity-80"
		>
			<ChatCard variant="activity" className="min-h-11 max-w-[min(68ch,100%)] justify-center">
				<ChatCardLine leading={native ? <LibraryIcon size={16} /> : <ExternalLinkIcon />} trailing={<Text className="text-body font-medium text-info">{native ? nativeLabel : "Abrir no navegador"}</Text>}>
					<Text numberOfLines={1} className="text-sm font-medium">
						{item.title}
					</Text>
				</ChatCardLine>
			</ChatCard>
		</Pressable>
	);
}
