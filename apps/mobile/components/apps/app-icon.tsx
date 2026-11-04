import * as React from "react";
import { Image } from "react-native";
import { SvgUri } from "react-native-svg";
import { IconTile } from "@/components/catalog/catalog-parts";
import { Text } from "@/components/ui/text";
import { initialOf, isSvgUri, resolveIconUri } from "@/lib/apps";
import { useAtlasSession } from "@/lib/atlas-session";

/**
 * Ícone de um aplicativo: o logo (SVG ou imagem) num quadrado de superfície, ou a inicial do nome quando não há logo ou
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
				{isSvgUri(uri) ? <SvgUri uri={uri} width={inner} height={inner} onError={() => setFailed(uri)} /> : <Image source={{ uri }} style={{ width: inner, height: inner }} resizeMode="contain" accessibilityIgnoresInvertColors onError={() => setFailed(uri)} />}
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
