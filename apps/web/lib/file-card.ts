import { attachmentKindOf, fileCategory, formatFileSize, type FileCategory } from "@workspace/shared";

/** Zip e binário não têm prévia: tocar no cartão baixa o arquivo direto. */
export function isPreviewableFile(filename: string, mime = ""): boolean {
	const kind = attachmentKindOf(filename, mime);
	return kind !== "zip" && kind !== "other";
}

/** URL autenticada do arquivo (cookie de sessão; o rewrite do Next leva para a API). */
export function fileDownloadPath(artifactId: string, opts: { inline?: boolean } = {}): string {
	return `/v1/files/${encodeURIComponent(artifactId)}${opts.inline ? "?inline=1" : ""}`;
}

export function filePreviewPath(artifactId: string): string {
	return `/v1/files/${encodeURIComponent(artifactId)}/preview`;
}

/** "PDF · 1,2 MB · v2": linha de descrição do cartão. */
export function fileCardDescription(input: { filename: string; size: number; version?: number }): string {
	const ext = input.filename.includes(".") ? input.filename.split(".").pop()!.slice(0, 5).toUpperCase() : "ARQUIVO";
	const parts = [ext, formatFileSize(input.size)];
	if ((input.version ?? 1) > 1) parts.push(`v${input.version}`);
	return parts.filter(Boolean).join(" · ");
}

/** Cor do ícone por categoria (PDF vermelho, DOCX azul, planilha verde, PPTX laranja). */
export const FILE_CATEGORY_TONE: Record<FileCategory, string> = {
	pdf: "bg-red-500/15 text-red-500",
	docx: "bg-blue-500/15 text-blue-500",
	sheet: "bg-emerald-500/15 text-emerald-500",
	pptx: "bg-orange-500/15 text-orange-500",
	code: "bg-violet-500/15 text-violet-500",
	text: "bg-muted text-muted-foreground",
	image: "bg-pink-500/15 text-pink-500",
	archive: "bg-amber-500/15 text-amber-500",
};

export { fileCategory };
