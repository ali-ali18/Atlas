"use client";

import { PlusIcon } from "lucide-react";
import { type ReactElement, type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { FileAttachment, LIBRARY_REFRESH_EVENT } from "@/components/ai-elements/files/file-attachment";
import { listBotArtifacts, type BotLibraryFile } from "@/lib/atlas-api";
import type { Routine } from "../data";
import { LibrarySection } from "./library-section";
import { BotPagesSection } from "./pages-library";

export const LIBRARY_EMPTY_TEXT =
	"Os documentos que este Bot cria (PDF, Word, Excel, PowerPoint e outros arquivos) aparecem aqui";

/** Lista de arquivos (cartões de arquivo) com estado vazio; pura para teste. */
export function BotLibraryList({
	files,
	hasMore,
	loadingMore,
	onLoadMore,
}: {
	files: BotLibraryFile[];
	hasMore?: boolean;
	loadingMore?: boolean;
	onLoadMore?: () => void;
}) {
	if (files.length === 0) {
		return (
			<p className="px-4 py-10 text-center text-muted-foreground text-xs leading-relaxed">
				{LIBRARY_EMPTY_TEXT}
			</p>
		);
	}
	return (
		<ul aria-label="Arquivos do Bot" className="m-0 flex list-none flex-col gap-2 p-0">
			{files.map((file) => (
				<li className="min-w-0" key={file.id}>
					<FileAttachment
						fullWidth
						artifactId={file.id}
						filename={file.filename}
						size={file.size}
						version={file.version}
					/>
				</li>
			))}
			{hasMore ? (
				<li>
					<Button disabled={loadingMore} onClick={onLoadMore} size="sm" variant="ghost">
						{loadingMore ? "Carregando..." : "Ver mais"}
					</Button>
				</li>
			) : null}
		</ul>
	);
}

/** Seção Documentos: recarrega ao abrir e quando surge um cartão de arquivo no chat. */
export function BotDocuments({ botId, active }: { botId: string; active: boolean }) {
	const [files, setFiles] = useState<BotLibraryFile[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);

	const reload = useCallback(() => {
		let stale = false;
		listBotArtifacts(botId, { limit: 30 })
			.then((page) => {
				if (stale) return;
				setFiles(page.files);
				setCursor(page.nextCursor);
			})
			.catch(() => undefined);
		return () => {
			stale = true;
		};
	}, [botId]);

	useEffect(() => {
		setFiles([]);
		setCursor(null);
	}, [botId]);

	useEffect(() => {
		if (!active) return;
		return reload();
	}, [active, reload]);

	useEffect(() => {
		let timer: number | undefined;
		const onRefresh = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				reload();
			}, 800);
		};
		window.addEventListener(LIBRARY_REFRESH_EVENT, onRefresh);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener(LIBRARY_REFRESH_EVENT, onRefresh);
		};
	}, [reload]);

	const loadMore = () => {
		if (!cursor) return;
		setLoadingMore(true);
		listBotArtifacts(botId, { limit: 30, cursor })
			.then((page) => {
				setFiles((current) => [...current, ...page.files.filter((f) => !current.some((c) => c.id === f.id))]);
				setCursor(page.nextCursor);
			})
			.catch(() => undefined)
			.finally(() => setLoadingMore(false));
	};

	return (
		<BotLibraryList
			files={files}
			hasMore={cursor !== null}
			loadingMore={loadingMore}
			onLoadMore={loadMore}
		/>
	);
}

/**
 * Aba Biblioteca em seções recolhíveis: Páginas (aberta), Documentos e Rotinas (fechadas). A seção Rotinas
 * recebe o conteúdo pronto (a lista, os toggles e o histórico moram no painel); o "+" fica no cabeçalho.
 */
export function BotLibrary({
	botId,
	active,
	routines,
	routinesBody,
	createRoutine,
}: {
	botId: string;
	active: boolean;
	routines: readonly Routine[];
	routinesBody: ReactNode;
	/** Monta o botão "+" com o seletor de tipo de rotina; só aparece quando já há rotinas. */
	createRoutine?: (trigger: ReactElement) => ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1" data-bot-library>
			<LibrarySection id="pages" title="Páginas">
				<BotPagesSection active={active} botId={botId} routines={routines} />
			</LibrarySection>
			<LibrarySection id="documents" title="Documentos">
				<BotDocuments active={active} botId={botId} />
			</LibrarySection>
			<LibrarySection
				action={
					routines.length > 0 && createRoutine
						? createRoutine(
								<Button aria-label="Criar rotina" size="icon-sm" variant="ghost">
									<PlusIcon />
								</Button>,
							)
						: null
				}
				count={routines.length}
				id="routines"
				title="Rotinas"
			>
				{routinesBody}
			</LibrarySection>
		</div>
	);
}
