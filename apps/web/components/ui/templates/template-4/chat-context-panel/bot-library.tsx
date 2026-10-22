"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { FileAttachment, LIBRARY_REFRESH_EVENT } from "@/components/ai-elements/files/file-attachment";
import { listBotArtifacts, type BotLibraryFile } from "@/lib/atlas-api";

export const LIBRARY_EMPTY_TEXT =
	"As páginas, os arquivos e os apps que este Bot cria aparecem aqui";

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

/** Aba Biblioteca: recarrega ao abrir a aba e quando surge um cartão de arquivo no chat. */
export function BotLibrary({ botId, active }: { botId: string; active: boolean }) {
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
