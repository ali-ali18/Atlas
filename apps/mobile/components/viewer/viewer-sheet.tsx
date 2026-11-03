import * as React from "react";
import { PageContent } from "@/components/page/page-content";
import { ContentSheet } from "@/components/ui/content-sheet";
import { Text } from "@/components/ui/text";
import { pageShareMessage } from "@/lib/document-view";
import { downloadForShare, fileErrorText, type FileTarget } from "@/lib/file-api";
import type { ApiFetch } from "@/lib/home-sync";
import { shareBytes, shareText } from "@/lib/share-file";
import { usePage } from "@/lib/use-page";
import { useDocument } from "@/lib/use-document";
import type { ViewerTarget } from "@/lib/viewer-target";
import { DocumentBody } from "./document-body";

type Common = { visible: boolean; onClose: () => void; apiFetch: ApiFetch };

/** Painel na folha: o mesmo corpo da tela cheia (`PageContent`). Compartilhar manda título + resumo em texto (sem link público: isso pede confirmação). */
function PageSheet({ target, visible, onClose, apiFetch }: Common & { target: Extract<ViewerTarget, { kind: "page" }> }) {
	const { state, retry } = usePage(apiFetch, target.id);
	const onShare = state.status === "ready" ? () => void shareText(pageShareMessage(state.page.title, state.page.spec.summary), state.page.title) : undefined;
	return (
		<ContentSheet visible={visible} onClose={onClose} onShare={onShare} shareLabel="Compartilhar painel">
			<PageContent state={state} fallbackTitle={target.title} onBack={onClose} onRetry={retry} />
		</ContentSheet>
	);
}

/** Documento na folha: nome ao lado do X, conteúdo nativo no corpo. Compartilhar: texto vai como texto, o resto como arquivo. */
function FileSheet({ target, visible, onClose, apiFetch }: Common & { target: FileTarget }) {
	const { state, retry } = useDocument(apiFetch, target);
	const [sharing, setSharing] = React.useState(false);
	const [notice, setNotice] = React.useState<string | null>(null);
	// Outro documento na mesma folha: o aviso do anterior não vale.
	// biome-ignore lint/correctness/useExhaustiveDependencies: zera o aviso quando o alvo muda.
	React.useEffect(() => setNotice(null), [target.id]);
	const share = React.useCallback(async () => {
		if (sharing || state.status !== "ready") return;
		setSharing(true);
		setNotice(null);
		try {
			if (state.content.type === "text") await shareText(state.content.text, target.filename);
			else {
				const file = await downloadForShare(apiFetch, target.id);
				const shared = await shareBytes(file.bytes, target.filename, target.mime || file.mime);
				if (!shared) setNotice("Compartilhar arquivo não está disponível neste aparelho.");
			}
		} catch (error) {
			setNotice(fileErrorText(error));
		} finally {
			setSharing(false);
		}
	}, [apiFetch, sharing, state, target]);
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
 * Folha de conteúdo sobre a tela atual (chat ou Biblioteca): abre o painel ou o documento do `target`. Ao fechar
 * (`target` null) guarda o último alvo só até a folha sumir; abrir outro alvo remonta com o estado limpo.
 */
export function ViewerSheet({ target, onClose, apiFetch }: { target: ViewerTarget | null; onClose: () => void; apiFetch: ApiFetch }) {
	const last = React.useRef<ViewerTarget | null>(target);
	if (target) last.current = target;
	const current = target ?? last.current;
	if (!current) return null;
	const key = `${current.kind}:${current.id}`;
	return current.kind === "page" ? <PageSheet key={key} target={current} visible={target !== null} onClose={onClose} apiFetch={apiFetch} /> : <FileSheet key={key} target={current} visible={target !== null} onClose={onClose} apiFetch={apiFetch} />;
}
