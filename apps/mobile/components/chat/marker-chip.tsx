import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { Pressable } from "react-native";
import { CloseIcon, SparklesIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Text } from "@/components/ui/text";
import { chatChrome } from "@/lib/chat-surface";
import { markerToken, type Marker } from "@/lib/composer-markers";
import { useAppColorScheme } from "@/lib/use-theme";

export const MARKER_HEIGHT = 30;

/**
 * Marcador `@bot` ou `/habilidade` dentro do campo: pílula com o avatar pequeno do bot (ou o ícone da habilidade) e o
 * texto como vai na mensagem (`@Nome`, `/slug`), como o chip do web. Tocar apaga o marcador (o backspace no começo do campo
 * também).
 */
export function MarkerChip({ marker, onRemove }: { marker: Marker; onRemove: (marker: Marker) => void }) {
	const chrome = chatChrome(useAppColorScheme());
	const token = markerToken(marker);
	return (
		<Pressable
			role="button"
			accessibilityLabel={`Remover ${token}`}
			onPress={() => onRemove(marker)}
			style={{ height: MARKER_HEIGHT, backgroundColor: chrome.control }}
			className="max-w-full flex-row items-center gap-1.5 rounded-full pl-2 pr-2 active:opacity-70"
		>
			{marker.kind === "bot" ? (
				<Avatar color={resolveColor(marker.color, marker.id)} shape={resolveShape(marker.shape, marker.id)} size={20} animated={false} eyeColor={chrome.control} />
			) : (
				<SparklesIcon size={14} />
			)}
			<Text numberOfLines={1} className="shrink text-body font-medium">
				{token}
			</Text>
			<CloseIcon size={12} />
		</Pressable>
	);
}
