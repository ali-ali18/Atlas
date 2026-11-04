import { resolveColor, resolveShape } from "@workspace/shared/avatar/identity";
import * as React from "react";
import { Pressable } from "react-native";
import { SparklesIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Text } from "@/components/ui/text";
import { chatChrome, routineSurface } from "@/lib/chat-surface";
import { markerToken, type Marker } from "@/lib/composer-markers";
import { useAppColorScheme } from "@/lib/use-theme";

export const MARKER_HEIGHT = 24;

/**
 * Marcador `@bot` ou `/habilidade` dentro do campo, depois de escolhido: só o avatar pequeno do bot (ou o ícone da
 * habilidade) e o nome em azul, sem fundo, sem o `@`/`/` e sem X (pedido do dono). O texto enviado continua `@Nome` /
 * `/slug` (`markerToken`). Tocar apaga o marcador; o backspace no começo do campo também.
 */
export function MarkerChip({ marker, onRemove }: { marker: Marker; onRemove: (marker: Marker) => void }) {
	const scheme = useAppColorScheme();
	const blue = routineSurface(scheme).link;
	const fieldFill = chatChrome(scheme).fill;
	return (
		<Pressable
			role="button"
			accessibilityLabel={`Remover ${markerToken(marker)}`}
			onPress={() => onRemove(marker)}
			style={{ height: MARKER_HEIGHT }}
			className="max-w-full flex-row items-center gap-1 active:opacity-70"
		>
			{marker.kind === "bot" ? (
				<Avatar color={resolveColor(marker.color, marker.id)} shape={resolveShape(marker.shape, marker.id)} size={18} animated={false} eyeColor={fieldFill} />
			) : (
				<SparklesIcon size={14} />
			)}
			<Text numberOfLines={1} style={{ color: blue }} className="shrink text-control font-medium">
				{marker.name.trim()}
			</Text>
		</Pressable>
	);
}
