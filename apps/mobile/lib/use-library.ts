import * as React from "react";
import type { ApiFetch } from "./home-sync";
import { libraryErrorText, listLibraryFiles, listLibraryPanels, type LibraryFile, type LibraryPanel } from "./library-api";

// Estado da Biblioteca de um bot, local à tela (sem cache em disco: busca ao abrir). Documentos vêm paginados
// (`nextCursor`), painéis de uma vez. Se só uma das duas listas falha, a outra aparece e o erro vira um aviso.

export type LibraryState = { files: LibraryFile[]; panels: LibraryPanel[]; nextCursor: string | null; loading: boolean; loadingMore: boolean; loaded: boolean; error: string | null };

const INITIAL: LibraryState = { files: [], panels: [], nextCursor: null, loading: false, loadingMore: false, loaded: false, error: null };

export function useLibrary(apiFetch: ApiFetch, botId: string): LibraryState & { reload: () => void; loadMore: () => void } {
	const [state, setState] = React.useState<LibraryState>(INITIAL);
	// Só a resposta do pedido mais novo vale (trocar de bot ou tentar de novo não deixa a lenta sobrescrever).
	const generation = React.useRef(0);
	const cursor = React.useRef<string | null>(null);
	const busyMore = React.useRef(false);
	cursor.current = state.nextCursor;

	const load = React.useCallback(async () => {
		const mine = ++generation.current;
		busyMore.current = false;
		setState((current) => ({ ...current, loading: true, loadingMore: false, error: null }));
		const [files, panels] = await Promise.allSettled([listLibraryFiles(apiFetch, botId), listLibraryPanels(apiFetch, botId)]);
		if (mine !== generation.current) return;
		const failure = files.status === "rejected" ? files.reason : panels.status === "rejected" ? panels.reason : null;
		setState({
			files: files.status === "fulfilled" ? files.value.files : [],
			panels: panels.status === "fulfilled" ? panels.value : [],
			nextCursor: files.status === "fulfilled" ? files.value.nextCursor : null,
			loading: false,
			loadingMore: false,
			loaded: true,
			error: failure === null ? null : libraryErrorText(failure),
		});
	}, [apiFetch, botId]);

	React.useEffect(() => {
		setState(INITIAL);
		void load();
		return () => {
			generation.current += 1;
		};
	}, [load]);

	const loadMore = React.useCallback(async () => {
		const after = cursor.current;
		if (!after || busyMore.current) return;
		busyMore.current = true;
		const mine = generation.current;
		setState((current) => ({ ...current, loadingMore: true, error: null }));
		try {
			const page = await listLibraryFiles(apiFetch, botId, { cursor: after });
			if (mine !== generation.current) return;
			setState((current) => {
				const known = new Set(current.files.map((file) => file.id));
				return { ...current, files: [...current.files, ...page.files.filter((file) => !known.has(file.id))], nextCursor: page.nextCursor, loadingMore: false };
			});
		} catch (error) {
			if (mine === generation.current) setState((current) => ({ ...current, loadingMore: false, error: libraryErrorText(error) }));
		} finally {
			if (mine === generation.current) busyMore.current = false;
		}
	}, [apiFetch, botId]);

	return { ...state, reload: () => void load(), loadMore: () => void loadMore() };
}
