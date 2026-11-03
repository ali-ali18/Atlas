import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { PageScreen } from "@/components/page/page-screen";
import { useAtlasSession } from "@/lib/atlas-session";
import { webChatUrl } from "@/lib/chat-links";
import { usePage } from "@/lib/use-page";

/**
 * Painel que o bot criou (`id` = pageId): tela nativa. O escopo por dono vem do servidor (painel de outro dono dá
 * 404, igual a um que não existe). `title` é só o título provisório do cartão do chat, enquanto carrega.
 */
export default function PageRoute() {
	const router = useRouter();
	const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
	const { apiFetch, serverUrl } = useAtlasSession();
	const { state, refresh, retry } = usePage(apiFetch, id);
	const goBack = React.useCallback(() => (router.canGoBack() ? router.back() : router.replace("/")), [router]);
	const botId = state.status === "ready" ? state.page.botId : null;
	const webUrl = botId ? webChatUrl(serverUrl, botId) : null;
	const openWeb = React.useMemo(() => (webUrl ? () => void WebBrowser.openBrowserAsync(webUrl).catch(() => undefined) : undefined), [webUrl]);
	return <PageScreen state={state} fallbackTitle={typeof title === "string" ? title : undefined} onBack={goBack} onRefresh={refresh} onRetry={retry} onOpenWeb={openWeb} />;
}
