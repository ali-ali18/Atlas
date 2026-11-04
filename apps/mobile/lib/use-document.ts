import * as React from "react";
import { type DocumentContent, fetchDocument, type FileTarget, fileErrorRetryable, fileErrorText } from "./file-api";
import type { ApiFetch } from "./home-sync";

export type DocumentState = { status: "loading" } | { status: "ready"; content: DocumentContent } | { status: "error"; message: string; retryable: boolean };

/** Baixa o documento da folha. Só a resposta da chamada mais nova vale; fechar a folha ignora o que ainda voava. */
export function useDocument(apiFetch: ApiFetch, target: FileTarget): { state: DocumentState; retry: () => void } {
	const [state, setState] = React.useState<DocumentState>({ status: "loading" });
	const generation = React.useRef(0);
	const { id, filename, mime, size } = target;
	const load = React.useCallback(() => {
		const mine = ++generation.current;
		setState({ status: "loading" });
		fetchDocument(apiFetch, { id, filename, mime, size }).then(
			(content) => mine === generation.current && setState({ status: "ready", content }),
			(error: unknown) => mine === generation.current && setState({ status: "error", message: fileErrorText(error), retryable: fileErrorRetryable(error) }),
		);
	}, [apiFetch, id, filename, mime, size]);
	React.useEffect(() => {
		load();
		return () => {
			generation.current += 1;
		};
	}, [load]);
	return { state, retry: load };
}
