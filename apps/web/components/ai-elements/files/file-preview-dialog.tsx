"use client";

import { DownloadIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { Component, type ReactNode, useEffect, useState } from "react";

import { Button } from "@workspace/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import type { FilePreview } from "@workspace/shared";

import { fetchFilePreview } from "@/lib/atlas-api";
import { fileCardDescription, fileDownloadPath } from "@/lib/file-card";
import { CodeView } from "./code-view";
import { SheetView } from "./sheet-view";

// pdf.js usa APIs do navegador: sem SSR.
const PdfViewer = dynamic(() => import("./pdf-viewer"), { ssr: false });

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; preview: FilePreview };

export function FilePreviewDialog({
	artifactId,
	filename,
	size,
	version,
	open,
	onOpenChange,
}: {
	artifactId: string;
	filename: string;
	size: number;
	version?: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [state, setState] = useState<State>({ status: "loading" });

	useEffect(() => {
		if (!open) return;
		setState({ status: "loading" });
		let cancelled = false;
		fetchFilePreview(artifactId)
			.then((preview) => {
				if (!cancelled) setState({ status: "ready", preview });
			})
			.catch(() => {
				if (!cancelled) setState({ status: "error", message: "Não foi possível carregar a prévia. Você ainda pode baixar o arquivo." });
			});
		return () => {
			cancelled = true;
		};
	}, [artifactId, open]);

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="flex h-[85vh] w-[min(64rem,95vw)] max-w-none flex-col gap-3 sm:max-w-none">
				<DialogHeader className="pr-12">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<DialogTitle className="truncate">{filename}</DialogTitle>
							<DialogDescription>{fileCardDescription({ filename, size, version })}</DialogDescription>
						</div>
						<Button
							aria-label={`Baixar ${filename}`}
							nativeButton={false}
							render={<a download={filename} href={fileDownloadPath(artifactId)} />}
							size="icon-sm"
							variant="ghost"
						>
							<DownloadIcon />
						</Button>
					</div>
				</DialogHeader>
				<div className="flex min-h-0 flex-1 flex-col overflow-auto">
					{state.status === "loading" ? <p className="text-muted-foreground text-sm">Carregando prévia…</p> : null}
					{state.status === "error" ? (
						<div className="flex flex-col items-start gap-3" role="alert">
							<p className="text-destructive text-sm">{state.message}</p>
							<Button nativeButton={false} render={<a download={filename} href={fileDownloadPath(artifactId)} />} size="sm" variant="outline">
								<DownloadIcon /> Baixar
							</Button>
						</div>
					) : null}
					{state.status === "ready" ? <PreviewBody filename={filename} preview={state.preview} /> : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function PreviewBody({ preview, filename }: { preview: FilePreview; filename: string }) {
	switch (preview.kind) {
		case "url":
			return /\.pdf$/i.test(filename) ? (
				<PreviewErrorBoundary fallback={<p className="text-destructive text-sm">Não foi possível abrir o PDF aqui. Use o botão de baixar.</p>}>
					<PdfViewer url={preview.url} />
				</PreviewErrorBoundary>
			) : (
				// eslint-disable-next-line @next/next/no-img-element
				<img alt={filename} className="mx-auto max-h-full object-contain" src={preview.url} />
			);
		case "html":
			// HTML do docx já sanitizado no servidor (sanitize-html, sem script/handlers).
			return (
				<div className="mx-auto w-full max-w-[44rem] rounded-md bg-white p-10 text-neutral-900 shadow-lg [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:mb-2 [&_table]:my-3 [&_table]:w-full [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:bg-neutral-100 [&_th]:px-2 [&_th]:py-1">
					<div dangerouslySetInnerHTML={{ __html: preview.html }} />
				</div>
			);
		case "sheets":
			return <SheetView sheets={preview.sheets} />;
		case "text":
			return (
				<div className="flex flex-col gap-2">
					<CodeView language={preview.language} text={preview.text} />
					{preview.truncated ? (
						<p className="text-muted-foreground text-xs">Prévia cortada. Baixe o arquivo para ver tudo.</p>
					) : null}
				</div>
			);
		case "none":
			return <p className="text-muted-foreground text-sm">{preview.reason}</p>;
	}
}

/** Erro do visualizador (ex.: pdf.js num navegador sem uma API nova) fica
 * na prévia, sem derrubar a página inteira. */
class PreviewErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}
