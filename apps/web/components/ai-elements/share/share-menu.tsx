"use client";

import { CopyIcon, DownloadIcon, FileTextIcon, LinkIcon, Share2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { useT } from "@/lib/i18n/provider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@workspace/ui/components/dropdown-menu";
import {
	buildPdfFromJpeg,
	canvasToBlob,
	copyImageOrDownload,
	dataUrlToBytes,
	downloadBlob,
	renderShareCanvas,
	shareFileName,
} from "@/lib/share-image";

export type ShareMenuProps = {
	/** Título do gráfico/painel (vira o nome do arquivo). */
	title: string;
	/** Nome do bot no rodapé da imagem. */
	botName?: string | null;
	/** Seletor do elemento a desenhar, procurado a partir do botão (`closest`). */
	targetSelector: string;
	/** Oferece "Baixar PDF" (painel). */
	pdf?: boolean;
	/** Oferece "Link público…" (painel salvo); abre o diálogo de link. */
	onPublicLink?: () => void;
	className?: string;
};

type Status = { kind: "ok" | "error"; text: string } | null;

/**
 * Botão "Compartilhar": copiar imagem, baixar PNG (e PDF no painel), mais o link público quando oferecido.
 * A imagem é desenhada no navegador com o tema atual e leva o rodapé "bot · data". Sem suporte a copiar imagem
 * (Firefox, iOS antigo) o PNG é baixado e o aviso diz isso.
 */
export function ShareMenu({ title, botName, targetSelector, pdf = false, onPublicLink, className }: ShareMenuProps) {
	const t = useT();
	const anchor = useRef<HTMLSpanElement>(null);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<Status>(null);

	useEffect(() => {
		if (!status) return;
		const timer = window.setTimeout(() => setStatus(null), 3500);
		return () => window.clearTimeout(timer);
	}, [status]);

	const target = () => anchor.current?.closest<HTMLElement>(targetSelector) ?? null;

	async function run(task: (node: HTMLElement, now: Date) => Promise<Status>) {
		const node = target();
		if (!node || busy) return;
		setBusy(true);
		try {
			setStatus(await task(node, new Date()));
		} catch {
			setStatus({ kind: "error", text: t("share.imageError") });
		} finally {
			setBusy(false);
		}
	}

	const copy = () =>
		run(async (node, now) => {
			const fileName = shareFileName(title, "png", now);
			const canvas = await renderShareCanvas(node, { botName, now });
			const outcome = await copyImageOrDownload(canvasToBlob(canvas), fileName);
			return outcome === "copied"
				? { kind: "ok", text: t("share.imageCopied") }
				: { kind: "ok", text: t("share.imageDownloaded") };
		});

	const downloadPng = () =>
		run(async (node, now) => {
			const canvas = await renderShareCanvas(node, { botName, now });
			downloadBlob(await canvasToBlob(canvas), shareFileName(title, "png", now));
			return { kind: "ok", text: t("share.pngDownloaded") };
		});

	const downloadPdf = () =>
		run(async (node, now) => {
			const canvas = await renderShareCanvas(node, { botName, now });
			const bytes = buildPdfFromJpeg(dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.92)), canvas.width / 2, canvas.height / 2);
			downloadBlob(new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }), shareFileName(title, "pdf", now));
			return { kind: "ok", text: t("share.pdfDownloaded") };
		});

	return (
		<span className="inline-flex items-center gap-1" data-share-ignore ref={anchor}>
			{status ? (
				<span aria-live="polite" className={status.kind === "error" ? "text-destructive text-xs" : "text-muted-foreground text-xs"} role="status">
					{status.text}
				</span>
			) : null}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={t("share.menuLabel", { title })}
							className={className}
							disabled={busy}
							size="icon-sm"
							type="button"
							variant="ghost"
						/>
					}
				>
					<Share2Icon aria-hidden />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => void copy()}>
						<CopyIcon />
						{t("share.copyImage")}
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => void downloadPng()}>
						<DownloadIcon />
						{t("share.downloadPng")}
					</DropdownMenuItem>
					{pdf ? (
						<DropdownMenuItem onClick={() => void downloadPdf()}>
							<FileTextIcon />
							{t("share.downloadPdf")}
						</DropdownMenuItem>
					) : null}
					{onPublicLink ? (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={onPublicLink}>
								<LinkIcon />
								{t("share.publicLinkItem")}
							</DropdownMenuItem>
						</>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		</span>
	);
}
