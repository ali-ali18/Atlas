import * as React from "react";
import { Image, type ImageStyle, type StyleProp, View, type ViewStyle } from "react-native";
import { ImageIcon } from "@/components/icons";
import { Spinner } from "@/components/ui/spinner";
import { useAtlasSession } from "@/lib/atlas-session";
import type { ChatImage } from "@/lib/chat-types";
import { loadImageUri } from "@/lib/image-source";
import { useSurfaces } from "@/lib/use-surfaces";

type State = { status: "loading" } | { status: "ready"; uri: string } | { status: "failed" };

/** Baixa a imagem (com a sessão) ou usa a `uri` local segura; a memória é compartilhada entre cartão, miniatura e visualizador. */
export function useImageUri(image: Pick<ChatImage, "artifactId" | "mime" | "uri">): State {
	const { apiFetch } = useAtlasSession();
	const [state, setState] = React.useState<State>({ status: "loading" });
	React.useEffect(() => {
		let alive = true;
		setState({ status: "loading" });
		loadImageUri(apiFetch, image).then(
			(uri) => alive && setState({ status: "ready", uri }),
			() => alive && setState({ status: "failed" }),
		);
		return () => {
			alive = false;
		};
	}, [apiFetch, image.artifactId, image.mime, image.uri]);
	return state;
}

/**
 * A imagem do chat dentro de uma caixa: carregando (Spinner), falhou (ícone) ou pronta. `contain` mostra inteira (visualizador);
 * `cover` preenche (cartão e miniatura). O arredondamento vem do `style` de quem chama.
 */
export function ChatImageView({ image, style, resizeMode = "cover", label, tone = "chrome" }: { image: ChatImage; style?: StyleProp<ViewStyle>; resizeMode?: "cover" | "contain"; label?: string; tone?: "chrome" | "plain" }) {
	const surfaces = useSurfaces();
	const state = useImageUri(image);
	const box: StyleProp<ViewStyle> = [tone === "chrome" ? { backgroundColor: surfaces.chromeControl } : undefined, { overflow: "hidden" }, style];
	if (state.status === "ready") {
		return (
			<View style={box}>
				<Image source={{ uri: state.uri }} accessibilityLabel={label ?? image.alt ?? "Imagem"} resizeMode={resizeMode} style={{ width: "100%", height: "100%" } as StyleProp<ImageStyle>} />
			</View>
		);
	}
	return (
		<View style={box} className="items-center justify-center" accessibilityLabel={state.status === "failed" ? "Imagem indisponível" : "Carregando imagem"}>
			{state.status === "failed" ? <ImageIcon size={20} tone="muted-foreground" /> : <Spinner />}
		</View>
	);
}
