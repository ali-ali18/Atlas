import * as React from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { DROP_MESSAGE, HIDE_CHROME_JS, STORAGE_SHIM_JS, WATCH_DROP_JS, isAllowedNavigation, originOf } from "@/lib/computer-webview";

/** Antes do noVNC: o shim de storage primeiro (a página é um documento em sandbox), depois o visual. */
const BEFORE_LOAD_JS = `${STORAGE_SHIM_JS}${HIDE_CHROME_JS}`;

/**
 * A tela ao vivo da VM (noVNC) numa WebView. O `uri` leva um token que dá controle da VM por 10 min: ele só existe
 * aqui, em memória, e a WebView fica trancada na origem do servidor salvo (sem cookie do app, sem cache, sem janela
 * nova, sem arquivo local).
 *
 * - SOMENTE VER (`controlling` falso): `pointerEvents="none"`, o toque nem chega ao noVNC; quem pega a pinça e o
 *   arrastar é o `Zoomable` por fora.
 * - CONTROLE: o toque chega ao noVNC (que já mapeia toque em mouse: um dedo arrasta o ponteiro, toque clica). O
 *   `Zoomable` solta os gestos nesse modo; o zoom que já estava aplicado continua (a WebView está dentro do container
 *   transformado).
 */
export function ViewerWebView({ uri, reloadKey, controlling, onDrop }: { uri: string; reloadKey: number; controlling: boolean; onDrop: () => void }) {
	const origin = React.useMemo(() => originOf(uri), [uri]);
	const whitelist = React.useMemo(() => (origin ? [origin] : []), [origin]);
	if (!origin) return null;
	return (
		<View pointerEvents={controlling ? "auto" : "none"} style={{ flex: 1, backgroundColor: "#000000" }}>
			<WebView
				key={reloadKey}
				source={{ uri }}
				originWhitelist={whitelist}
				onShouldStartLoadWithRequest={(request) => isAllowedNavigation(request.url, origin)}
				javaScriptEnabled
				javaScriptCanOpenWindowsAutomatically={false}
				setSupportMultipleWindows={false}
				allowFileAccess={false}
				allowFileAccessFromFileURLs={false}
				allowUniversalAccessFromFileURLs={false}
				sharedCookiesEnabled={false}
				thirdPartyCookiesEnabled={false}
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
				injectedJavaScriptBeforeContentLoaded={BEFORE_LOAD_JS}
				injectedJavaScriptBeforeContentLoadedForMainFrameOnly
				injectedJavaScript={`${HIDE_CHROME_JS}${WATCH_DROP_JS}`}
				onMessage={(event) => {
					if (event.nativeEvent.data === DROP_MESSAGE) onDrop();
				}}
				onError={onDrop}
				onHttpError={onDrop}
				style={{ flex: 1, backgroundColor: "#000000" }}
				containerStyle={{ backgroundColor: "#000000" }}
				accessibilityLabel="Tela do computador do bot"
			/>
		</View>
	);
}
