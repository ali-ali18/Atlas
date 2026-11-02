import * as React from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { bridgeCall, parseBridgeMessage, type BridgeEvent } from "@/lib/viewer-bridge";
import { buildViewerHtml, isAllowedViewerNavigation } from "@/lib/viewer-page";

export type ViewerHandle = {
	/** Digita na VM: lista de keysyms (ver `lib/vm-keys.ts`). Só tem efeito no modo controle e com a conexão aberta. */
	typeKeys: (keys: number[]) => void;
};

type Props = {
	/** Endereço do servidor salvo: dele sai a CSP da página (só o WebSocket desse host). */
	serverUrl: string;
	/** `wss://…` com o token de propósito `ws`. Só passa por `injectJavaScript`: nunca vai na URL da página nem em log. */
	socketUrl: string | null;
	/** Muda a cada link novo: força uma conexão nova mesmo que a URL se repita. */
	socketKey: number;
	/** Modo controle (`viewOnly` desligado). */
	controlling: boolean;
	onEvent: (event: BridgeEvent) => void;
};

/**
 * A tela ao vivo da VM: o motor do noVNC dentro de uma página NOSSA (`lib/viewer-page.ts`) numa WebView. Nenhum HTML da
 * VM é carregado; a página só abre o WebSocket do servidor salvo (CSP) e conversa com o app pela ponte
 * (`lib/viewer-bridge.ts`). A WebView fica trancada: sem navegação, sem janela nova, sem arquivo, sem cookie, sem cache,
 * em modo incógnito.
 *
 * - SOMENTE VER: `viewOnly` ligado e `pointerEvents="none"`: o toque nem chega à página; o `Zoomable` por fora cuida
 *   da pinça e do arrastar.
 * - CONTROLE: `viewOnly` desligado e o toque chega ao noVNC (que o converte em mouse). O `Zoomable` solta os gestos.
 */
export const ViewerWebView = React.forwardRef<ViewerHandle, Props>(function ViewerWebView({ serverUrl, socketUrl, socketKey, controlling, onEvent }, ref) {
	const html = React.useMemo(() => buildViewerHtml(serverUrl), [serverUrl]);
	const webRef = React.useRef<React.ComponentRef<typeof WebView>>(null);
	const [ready, setReady] = React.useState(false);
	const controllingRef = React.useRef(controlling);
	controllingRef.current = controlling;
	const emit = React.useRef(onEvent);
	emit.current = onEvent;

	const run = React.useCallback((js: string) => webRef.current?.injectJavaScript(js), []);
	React.useImperativeHandle(ref, () => ({ typeKeys: (keys) => run(bridgeCall("keys", keys)) }), [run]);

	// Conecta quando a página avisou que o noVNC carregou e há um endereço (também a cada link novo).
	React.useEffect(() => {
		if (ready && socketUrl) run(bridgeCall("connect", socketUrl, !controllingRef.current));
	}, [ready, socketUrl, socketKey, run]);
	React.useEffect(() => {
		if (ready) run(bridgeCall("setViewOnly", !controlling));
	}, [ready, controlling, run]);

	if (!html) return null;
	const lost = () => {
		setReady(false);
		emit.current({ t: "error" });
	};
	return (
		<View pointerEvents={controlling ? "auto" : "none"} style={{ flex: 1, backgroundColor: "#000000" }}>
			<WebView
				ref={webRef}
				source={{ html }}
				originWhitelist={["about:blank"]}
				onShouldStartLoadWithRequest={(request) => isAllowedViewerNavigation(request.url)}
				javaScriptEnabled
				javaScriptCanOpenWindowsAutomatically={false}
				setSupportMultipleWindows={false}
				allowFileAccess={false}
				allowFileAccessFromFileURLs={false}
				allowUniversalAccessFromFileURLs={false}
				sharedCookiesEnabled={false}
				thirdPartyCookiesEnabled={false}
				mixedContentMode="never"
				incognito
				cacheEnabled={false}
				mediaPlaybackRequiresUserAction
				allowsInlineMediaPlayback
				bounces={false}
				scrollEnabled={false}
				overScrollMode="never"
				showsHorizontalScrollIndicator={false}
				showsVerticalScrollIndicator={false}
				contentInsetAdjustmentBehavior="never"
				onMessage={(event) => {
					const message = parseBridgeMessage(event.nativeEvent.data);
					if (!message) return;
					if (message.t === "ready") setReady(true);
					emit.current(message);
				}}
				onError={lost}
				onHttpError={lost}
				onContentProcessDidTerminate={lost}
				onRenderProcessGone={lost}
				style={{ flex: 1, backgroundColor: "#000000" }}
				containerStyle={{ backgroundColor: "#000000" }}
				accessibilityLabel="Tela do computador do bot"
			/>
		</View>
	);
});
