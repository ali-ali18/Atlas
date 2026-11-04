import * as React from "react";
import { Pressable, View } from "react-native";
import { FileIcon, FileSpreadsheetIcon, FileTextIcon, ImageIcon, LayoutDashboardIcon, PresentationIcon } from "@/components/icons";
import { Text } from "@/components/ui/text";
import { chatChrome, routineSurface } from "@/lib/chat-surface";
import type { LibraryItem, LibraryItemKind } from "@/lib/library-items";
import { useAppColorScheme } from "@/lib/use-theme";

/** Miniatura quadrada (40) e respiro da esquerda (16) + espaço até o texto (12): o separador começa em `TEXT_INSET`. */
export const LIBRARY_TILE = 40;
const LEFT = 16;
const GAP = 12;
export const TEXT_INSET = LEFT + LIBRARY_TILE + GAP;

function KindIcon({ kind }: { kind: LibraryItemKind }) {
	switch (kind) {
		case "panel":
			return <LayoutDashboardIcon />;
		case "document":
			return <FileTextIcon />;
		case "sheet":
			return <FileSpreadsheetIcon />;
		case "presentation":
			return <PresentationIcon />;
		case "image":
			return <ImageIcon />;
		default:
			return <FileIcon />;
	}
}

/**
 * Linha da Biblioteca, como no Grok: ícone do tipo num quadrado, título em uma linha (truncado com "…") e o subtítulo
 * cinza ("Documento · 1 d"). O separador de cima começa no texto e vai até a borda direita do cartão.
 */
export function LibraryRow({ item, subtitle, first, onOpen }: { item: LibraryItem; subtitle: string; first: boolean; onOpen: (item: LibraryItem) => void }) {
	const scheme = useAppColorScheme();
	const surface = routineSurface(scheme);
	return (
		<Pressable role="button" accessibilityLabel={`${item.title}, ${subtitle}`} onPress={() => onOpen(item)} className="flex-row items-center py-3 pr-4 active:opacity-80" style={{ paddingLeft: LEFT, gap: GAP }}>
			{first ? null : <View pointerEvents="none" style={{ position: "absolute", top: 0, left: TEXT_INSET, right: 0, height: 1, backgroundColor: surface.edge }} />}
			<View className="items-center justify-center" style={{ width: LIBRARY_TILE, height: LIBRARY_TILE, borderRadius: 10, backgroundColor: chatChrome(scheme).control }}>
				<KindIcon kind={item.kind} />
			</View>
			<View className="min-w-0 flex-1">
				<Text numberOfLines={1} ellipsizeMode="tail" className="text-lg">
					{item.title}
				</Text>
				<Text numberOfLines={1} variant="muted" className="text-base">
					{subtitle}
				</Text>
			</View>
		</Pressable>
	);
}
