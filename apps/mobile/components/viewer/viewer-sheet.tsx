import * as React from "react";
import { PageContent } from "@/components/page/page-content";
import { ContentSheet } from "@/components/ui/content-sheet";
import { Text } from "@/components/ui/text";
import { pageShareMessage, textFitsShare } from "@/lib/document-view";
import { downloadForShare, fileErrorText, type FileTarget } from "@/lib/file-api";
import type { ApiFetch } from "@/lib/home-sync";
import { ShareFileError, shareBytes, shareText } from "@/lib/share-file";
import { usePage } from "@/lib/use-page";
import { useDocument } from "@/lib/use-document";
import type { ViewerTarget } from "@/lib/viewer-target";
import { DocumentBody } from "./document-body";

type Common = { visible: boolean; onClose: () => void; apiFetch: ApiFetch };

/** Painel na folha: o mesmo corpo da tela cheia (`PageContent`). Compartilhar manda título + resumo em texto (sem link público: isso pede confirmação). */
function PageSheet({ target, visible, onClose, apiFetch }: Common & { target: Extract<ViewerTarget, { kind: "page" }> }) {
	const { state, retry, refresh } = usePage(apiFetch, target.id);
	const onShare = state.status === "ready" ? () => void shareText(pageShareMessage(state.page.title, state.page.spec.summary), state.page.title) : undefined;
	return (
		<ContentSheet visible={visible} onClose={onClose} onShare={onShare} shareLabel="Compartilhar painel" refresh={state.status === "ready" ? { refreshing: state.refreshing, onRefresh: refresh } : undefined}>
			<PageContent state={state} fallbackTitle={target.title} onBack={onClose} onRetry={retry} />
		</ContentSheet>
	);
}

/** Documento na folha: nome ao lado do X, conteúdo nativo no corpo. Compartilhar: texto vai como texto, o resto como arquivo. */
function FileSheet({ target, visible, onClose, apiFetch }: Common & { target: FileTarget }) {
	const { state, retry } = useDocument(apiFetch, target);
	const [sharing, setSharing] = React.useState(false);
	const [notice, setNotice] = React.useState<string | null>(null);
	// Fechar a folha desmonta isto; o compartilhar em voo não mexe mais na tela nem abre a folha do sistema depois disso.
	const alive = React.useRef(true);
	const busy = React.useRef(false);
	React.useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const share = React.useCallback(async () => {
		if (busy.current || state.status !== "ready") return;
		busy.current = true;
		setSharing(true);
		setNotice(null);
		try {
			if (state.content.type === "text" && textFitsShare(state.content.text)) await shareText(state.content.text, target.filename);
			else {
				// Imagem, PDF, Office, documento grande e texto acima do limite vão como arquivo (nada é cortado sem avisar).
				const file = await downloadForShare(apiFetch, target.id);
				if (!alive.current) return;
				const shared = await shareBytes(file.bytes, target.filename, target.mime || file.mime);
				if (!shared && alive.current) setNotice("Compartilhar arquivo não está disponível neste aparelho.");
			}
		} catch (error) {
			if (alive.current) setNotice(error instanceof ShareFileError ? error.message : fileErrorText(error));
		} finally {
			busy.current = false;
			if (alive.current) setSharing(false);
		}
	}, [apiFetch, state, target]);
	return (
		<ContentSheet visible={visible} onClose={onClose} title={target.filename} onShare={state.status === "ready" ? () => void share() : undefined} shareLabel="Compartilhar documento">
			<DocumentBody state={state} target={target} onRetry={retry} onShare={() => void share()} sharing={sharing} />
			{notice ? (
				<Text variant="muted" className="pt-3 text-center text-control" accessibilityLiveRegion="polite">
					{notice}
				</Text>
			) : null}
		</ContentSheet>
	);
}

/**
 * Folha de conteúdo sobre a tela atual (chat ou Biblioteca): abre o painel ou o documento do `target`. Fechada
 * (`target` null) não renderiza nada: o conteúdo (inclusive a imagem de até 8 MB) sai da memória, e reabrir busca de
 * novo, sem mostrar o que estava velho. A folha já some de uma vez ao fechar (o `Modal` esconde), então não há saída animada a perder.
 */
export function ViewerSheet({ target, onClose, apiFetch }: { target: ViewerTarget | null; onClose: () => void; apiFetch: ApiFetch }) {
	if (!target) return null;
	const key = `${target.kind}:${target.id}`;
	return target.kind === "page" ? <PageSheet key={key} target={target} visible onClose={onClose} apiFetch={apiFetch} /> : <FileSheet key={key} target={target} visible onClose={onClose} apiFetch={apiFetch} />;
}
