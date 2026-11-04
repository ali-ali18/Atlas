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
	const { serverUrl, client } = useAtlasSession();
	const uri = resolveIconUri(src, serverUrl);
	// Imagem que o próprio servidor serve atrás do login (`/v1/...`, ex.: logo de conector próprio) precisa do cookie: o
	// `expo-image` não usa o `apiFetch`. O cookie só sai para o servidor salvo (o caminho é relativo a ele).
	const needsAuth = uri !== null && src !== null && src.startsWith("/v1/");
	const [cookie, setCookie] = React.useState<string | null>(null);
	React.useEffect(() => {
		if (!needsAuth || !client) return;
		let alive = true;
		void Promise.resolve(client.getCookie()).then(
			(value) => {
				if (alive) setCookie(value || null);
			},
			() => undefined,
		);
		return () => {
			alive = false;
		};
	}, [needsAuth, client]);
	const [failed, setFailed] = React.useState<string | null>(null);
	const inner = Math.round(size * 0.58);
	if (uri && failed !== uri && (!needsAuth || cookie)) {
		return (
			<IconTile size={size}>
				<Image source={needsAuth && cookie ? { uri, headers: { cookie } } : { uri }} style={{ width: inner, height: inner }} contentFit="contain" cachePolicy="disk" recyclingKey={uri} accessible={false} onError={() => setFailed(uri)} />
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
