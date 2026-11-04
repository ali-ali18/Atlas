import * as React from "react";
import { Image } from "expo-image";
import { IconTile } from "@/components/catalog/catalog-parts";
import { Text } from "@/components/ui/text";
import { initialOf, resolveIconUri } from "@/lib/apps";
import { useAtlasSession } from "@/lib/atlas-session";

/**
 * Ícone de um aplicativo: o logo (SVG ou imagem, decodificado nativamente pelo `expo-image`: o `Image` do RN não desenha
 * SVG no Android e o `SvgUri` interpretaria cada logo na thread JS, pesado numa lista longa) num quadrado de superfície, ou a inicial do nome quando não há logo ou
 * ele falha ao carregar. Logo de marca fica com respiro dentro do quadrado (não encosta na borda).
 */
export function AppIcon({ src, name, size = 56 }: { src: string | null; name: string; size?: number }) {
	const { serverUrl } = useAtlasSession();
	const uri = resolveIconUri(src, serverUrl);
	const [failed, setFailed] = React.useState<string | null>(null);
	const inner = Math.round(size * 0.58);
	if (uri && failed !== uri) {
		return (
			<IconTile size={size}>
				<Image source={{ uri }} style={{ width: inner, height: inner }} contentFit="contain" cachePolicy="disk" recyclingKey={uri} accessible={false} onError={() => setFailed(uri)} />
			</IconTile>
		);
	}
	return (
		<IconTile size={size}>
			<Text style={{ fontSize: Math.round(size * 0.4) }} className="font-semibold text-muted-foreground">
				{initialOf(name)}
			</Text>
		</IconTile>
	);
}
