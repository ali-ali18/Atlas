"use client";

import { DownloadIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
	Attachment,
	AttachmentAction,
	AttachmentActions,
	AttachmentContent,
	AttachmentDescription,
	AttachmentGroup,
	AttachmentMedia,
	AttachmentTitle,
	AttachmentTrigger,
} from "@workspace/ui/components/attachment";

import { fileCardDescription, fileCategory, fileDownloadPath, isPreviewableFile } from "@/lib/file-card";
import { FileTypeIcon } from "./file-icon";
import { FilePreviewDialog } from "./file-preview-dialog";

/** Evento global: um cartão de arquivo apareceu no chat (a Biblioteca do bot recarrega). */
export const LIBRARY_REFRESH_EVENT = "atlas:library-refresh";

export type FileAttachmentProps = {
	artifactId: string;
	filename: string;
	size: number;
	version?: number;
	mime?: string;
	/** Anexo enviado pelo usuário: alinhado à direita, como a mensagem dele. */
	origin?: "user";
	/** Ocupa a largura toda da coluna (Biblioteca), em vez de encolher ao conteúdo. */
	fullWidth?: boolean;
};

/**
 * Cartão compacto de arquivo gerado pelo agente: ícone por tipo, nome, tamanho
 * e download. Clicar abre a prévia; o download usa a rota autenticada.
 */
export function FileAttachment({ artifactId, filename, size, version, mime, origin, fullWidth }: FileAttachmentProps) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		// Anexo do usuário não é da biblioteca do bot.
		if (origin !== "user") window.dispatchEvent(new Event(LIBRARY_REFRESH_EVENT));
	}, [artifactId, origin]);
	const category = fileCategory(filename);
	const previewable = isPreviewableFile(filename, mime);
	return (
		// px-1/-mx-1: o grupo rola na horizontal (overflow-x) e cortava o anel/borda
		// do cartão nas laterais; o respiro fica dentro e o alinhamento não muda.
		<AttachmentGroup className={origin === "user" ? "-mx-1 ml-auto w-fit max-w-full px-1" : "-mx-1 px-1"}>
			<Attachment className={fullWidth ? "w-full max-w-full" : "min-w-56 max-w-[min(24rem,100%)]"} data-origin={origin}>
				<AttachmentMedia className="overflow-hidden">
					<FileTypeIcon category={category} />
				</AttachmentMedia>
				<AttachmentContent>
					<AttachmentTitle title={filename}>{filename}</AttachmentTitle>
					<AttachmentDescription>{fileCardDescription({ filename, size, version })}</AttachmentDescription>
				</AttachmentContent>
				{previewable ? (
					<AttachmentTrigger aria-label={`Abrir prévia de ${filename}`} onClick={() => setOpen(true)} />
				) : (
					<AttachmentTrigger aria-label={`Baixar ${filename}`} render={<a download={filename} href={fileDownloadPath(artifactId)} />} />
				)}
				<AttachmentActions>
					<AttachmentAction
						aria-label={`Baixar ${filename}`}
						nativeButton={false}
						render={<a download={filename} href={fileDownloadPath(artifactId)} />}
					>
						<DownloadIcon />
					</AttachmentAction>
				</AttachmentActions>
			</Attachment>
			{open && previewable ? (
				<FilePreviewDialog
					artifactId={artifactId}
					filename={filename}
					onOpenChange={setOpen}
					open={open}
					size={size}
					version={version}
				/>
			) : null}
		</AttachmentGroup>
	);
}
