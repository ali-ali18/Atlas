import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as React from "react";
import { LibraryView } from "@/components/library/library-view";
import { useAtlasSession } from "@/lib/atlas-session";
import { webChatUrl } from "@/lib/chat-links";
import { mergeLibraryItems } from "@/lib/library-items";
import { useLibrary } from "@/lib/use-library";

/**
 * Biblioteca do bot (`id` = id do bot): documentos e painéis juntos, mais novos primeiro. Tocar numa linha abre o chat
 * do bot no navegador: o `GET /v1/files/:id` e o painel exigem o cookie da sessão, que fica no cabeçalho do app e que o
 * navegador do sistema não tem, então ainda não há como abrir o arquivo em si (sem visualizador nativo nesta etapa).
 */
export default function LibraryScreen() {
	const router = useRouter();
	const { id } = useLocalSearchParams<{ id: string }>();
	const { apiFetch, serverUrl } = useAtlasSession();
	const library = useLibrary(apiFetch, id);
	const items = React.useMemo(() => mergeLibraryItems(library.files, library.panels), [library.files, library.panels]);
	// Relógio fixo por carga: as idades não "andam" enquanto a pessoa lê, e o agrupamento não tremula.
	// biome-ignore lint/correctness/useExhaustiveDependencies: recalcula de propósito quando uma carga termina.
	const now = React.useMemo(() => new Date(), [library.loaded, library.files.length, library.panels.length]);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace(`/profile/${encodeURIComponent(id)}` as never));
	const open = () => {
		const url = webChatUrl(serverUrl, id);
		if (url) void WebBrowser.openBrowserAsync(url).catch(() => undefined);
	};
	return <LibraryView items={items} now={now} loading={library.loading || !library.loaded} loadingMore={library.loadingMore} hasMore={library.nextCursor !== null} error={library.error} onBack={goBack} onOpen={open} onRetry={library.reload} onLoadMore={library.loadMore} />;
}
