import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { LibraryView } from "@/components/library/library-view";
import { useAtlasSession } from "@/lib/atlas-session";
import { ViewerSheet } from "@/components/viewer/viewer-sheet";
import { mergeLibraryItems, type LibraryItem } from "@/lib/library-items";
import { useLibrary } from "@/lib/use-library";
import { type ViewerTarget, viewerTargetForLibraryItem } from "@/lib/viewer-target";

/**
 * Biblioteca do bot (`id` = id do bot): documentos e painéis juntos, mais novos primeiro. Tocar num painel ou num
 * documento abre a folha de conteúdo (`ViewerSheet`) por cima da lista: o app baixa com a sessão no cabeçalho, que o
 * navegador do sistema não tem.
 */
export default function LibraryScreen() {
	const router = useRouter();
	const { id } = useLocalSearchParams<{ id: string }>();
	const { apiFetch } = useAtlasSession();
	const [viewer, setViewer] = React.useState<ViewerTarget | null>(null);
	const library = useLibrary(apiFetch, id);
	const items = React.useMemo(() => mergeLibraryItems(library.files, library.panels), [library.files, library.panels]);
	// Relógio fixo por carga: as idades não "andam" enquanto a pessoa lê, e o agrupamento não tremula.
	// biome-ignore lint/correctness/useExhaustiveDependencies: recalcula de propósito quando uma carga termina.
	const now = React.useMemo(() => new Date(), [library.loaded, library.files.length, library.panels.length]);
	const goBack = () => (router.canGoBack() ? router.back() : router.replace(`/profile/${encodeURIComponent(id)}` as never));
	// Painel e documento abrem a folha por cima da Biblioteca (a lista continua atrás, escurecida).
	const open = (item: LibraryItem) => setViewer(viewerTargetForLibraryItem(item));
	return (
		<>
			<LibraryView items={items} now={now} loading={library.loading || !library.loaded} loadingMore={library.loadingMore} hasMore={library.nextCursor !== null} error={library.error} onBack={goBack} onOpen={open} onRetry={library.reload} onLoadMore={library.loadMore} />
			<ViewerSheet target={viewer} onClose={() => setViewer(null)} apiFetch={apiFetch} />
		</>
	);
}
