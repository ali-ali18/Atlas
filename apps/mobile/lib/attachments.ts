// Anexos do composer: decisões puras (roteamento por MIME, limites, nome com extensão, mensagens) e a lista de rascunhos.
// Os limites vêm de `@workspace/shared`, os mesmos do web e do servidor; o upload mora em `upload-api.ts`.
import { ALLOWED_IMAGE_MIMES, ATTACHMENT_LIMITS, fileExtension, IMAGE_LIMITS, sanitizeFilename } from "@workspace/shared";

export type AttachmentRoute = "image" | "file";

/** O que os seletores (fotos, câmera, arquivos) entregam, já sem a forma de cada módulo. */
export type PickedFile = { uri: string; name?: string | null; mime?: string | null; size?: number | null; width?: number | null; height?: number | null };

export type DraftStatus = "uploading" | "done" | "error";

/** Um anexo na fila do composer. `key` é do aparelho; `artifactId` só existe depois do upload. */
export type AttachmentDraft = {
	key: string;
	route: AttachmentRoute;
	uri: string;
	name: string;
	mime: string;
	size?: number;
	width?: number;
	height?: number;
	status: DraftStatus;
	artifactId?: string;
	error?: string;
};

/** O que o envio leva: o id do arquivo no servidor e o bastante para desenhar o balão otimista. */
export type OutgoingAttachment = Pick<AttachmentDraft, "route" | "uri" | "name" | "mime" | "size" | "width" | "height"> & { artifactId: string };

export const IMAGE_MAX_BYTES_LABEL = "10 MB";
export const FILE_MAX_BYTES_LABEL = "20 MB";
export const FILE_TOO_BIG_NOW = "Arquivo grande demais para enviar agora";

const EXT_BY_MIME: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"application/pdf": "pdf",
	"text/plain": "txt",
	"text/csv": "csv",
	"text/markdown": "md",
	"application/json": "json",
	"application/zip": "zip",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** `image/*` sobe pelo caminho das imagens (o servidor recusa imagem em `/files` com 415); o resto é arquivo. */
export function routeFor(mime: string | null | undefined): AttachmentRoute {
	return (mime ?? "").toLowerCase().startsWith("image/") ? "image" : "file";
}

function normalizeMime(mime: string | null | undefined): string {
	const base = (mime ?? "").split(";")[0]!.trim().toLowerCase();
	return base === "image/jpg" ? "image/jpeg" : base;
}

/** MIME de uma extensão de imagem (a câmera e a galeria às vezes não informam o tipo). */
function imageMimeFromName(name: string): string {
	const ext = fileExtension(name);
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "png" || ext === "webp" || ext === "gif" || ext === "heic" || ext === "heif") return `image/${ext}`;
	return "";
}

/** O servidor decide o tipo pelo nome: garante uma extensão que combine com o MIME (foto sem nome vira `foto.jpg`). */
export function uploadName(name: string | null | undefined, mime: string, route: AttachmentRoute): string {
	const wanted = EXT_BY_MIME[mime];
	const fallbackStem = route === "image" ? "foto" : "arquivo";
	const safe = sanitizeFilename(name?.trim() || fallbackStem);
	const current = fileExtension(safe);
	if (!wanted) return safe;
	if (route === "image") {
		// Foto: a extensão tem de ser a do formato real (o nome do iOS vem como "IMG_1.HEIC" mesmo convertida em JPEG).
		const stem = current ? safe.slice(0, safe.length - current.length - 1) : safe;
		return `${stem || fallbackStem}.${wanted}`;
	}
	return current ? safe : `${safe}.${wanted}`;
}

export type Counts = { images: number; files: number };

export function countsOf(drafts: readonly AttachmentDraft[]): Counts {
	return { images: drafts.filter((draft) => draft.route === "image").length, files: drafts.filter((draft) => draft.route === "file").length };
}

export type Validation = { ok: true; route: AttachmentRoute; name: string; mime: string } | { ok: false; message: string };

const IMAGE_TYPES = new Set<string>(ALLOWED_IMAGE_MIMES);

/** Confere um item escolhido contra os limites antes de subir; `counts` é o que já está na fila. */
export function validatePicked(picked: PickedFile, counts: Counts): Validation {
	const rawName = picked.name?.trim() ?? "";
	let mime = normalizeMime(picked.mime);
	if (!mime || mime === "application/octet-stream") mime = imageMimeFromName(rawName) || mime;
	const route = routeFor(mime);
	const label = rawName || (route === "image" ? "A imagem" : "O arquivo");
	if (picked.size === 0) return { ok: false, message: `${label} está vazio.` };
	if (route === "image") {
		if (!IMAGE_TYPES.has(mime)) return { ok: false, message: `${label}: formato não aceito. Use PNG, JPEG, WebP ou GIF.` };
		if (typeof picked.size === "number" && picked.size > IMAGE_LIMITS.maxBytes) return { ok: false, message: `${label} passa de ${IMAGE_MAX_BYTES_LABEL}.` };
		if (counts.images >= IMAGE_LIMITS.maxPerMessage) return { ok: false, message: `No máximo ${IMAGE_LIMITS.maxPerMessage} imagens por mensagem.` };
	} else {
		if (typeof picked.size === "number" && picked.size > ATTACHMENT_LIMITS.maxBytes) return { ok: false, message: `${label} passa de ${FILE_MAX_BYTES_LABEL}.` };
		if (counts.files >= ATTACHMENT_LIMITS.maxPerMessage) return { ok: false, message: `No máximo ${ATTACHMENT_LIMITS.maxPerMessage} arquivos por mensagem.` };
	}
	return { ok: true, route, name: uploadName(rawName, mime, route), mime: mime || "application/octet-stream" };
}

/** Quantas imagens ainda cabem (limita a seleção múltipla da galeria). */
export function imageSlotsLeft(counts: Counts): number {
	return Math.max(0, IMAGE_LIMITS.maxPerMessage - counts.images);
}

export function fileSlotsLeft(counts: Counts): number {
	return Math.max(0, ATTACHMENT_LIMITS.maxPerMessage - counts.files);
}

/** Erro do upload em palavras simples (nunca o texto técnico do servidor). */
export function uploadErrorMessage(status: number | null, route: AttachmentRoute): string {
	if (status === null) return "Sem conexão. Remova e tente de novo.";
	if (status === 401) return "Sua sessão expirou. Entre de novo.";
	if (status === 413) return route === "image" ? `A imagem passa de ${IMAGE_MAX_BYTES_LABEL}.` : FILE_TOO_BIG_NOW;
	if (status === 415) return route === "image" ? "Formato de imagem não aceito." : "Esse tipo de arquivo não é aceito.";
	if (status === 429) return "Muitos envios seguidos. Espere um instante.";
	return "Não consegui enviar o anexo. Tente de novo.";
}

// ---- lista de rascunhos (funções puras) --------------------------------------------------------------

export function patchDraft(drafts: readonly AttachmentDraft[], key: string, patch: Partial<AttachmentDraft>): AttachmentDraft[] {
	return drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft));
}

export function removeDraft(drafts: readonly AttachmentDraft[], key: string): AttachmentDraft[] {
	return drafts.filter((draft) => draft.key !== key);
}

export const isUploading = (drafts: readonly AttachmentDraft[]): boolean => drafts.some((draft) => draft.status === "uploading");

/** Pode enviar: nada subindo e nada com erro pendente (o erro se remove antes). */
export function canSendAttachments(drafts: readonly AttachmentDraft[]): boolean {
	return drafts.every((draft) => draft.status === "done");
}

/** O corpo do servidor leva só os ids (imagens e arquivos no mesmo array). */
export function toRefs(outgoing: readonly OutgoingAttachment[]): { artifactId: string }[] {
	return outgoing.map(({ artifactId }) => ({ artifactId }));
}

/** Os anexos prontos, na ordem escolhida. */
export function toOutgoing(drafts: readonly AttachmentDraft[]): OutgoingAttachment[] {
	return drafts.flatMap((draft): OutgoingAttachment[] =>
		draft.status === "done" && draft.artifactId
			? [{ artifactId: draft.artifactId, route: draft.route, uri: draft.uri, name: draft.name, mime: draft.mime, ...(draft.size !== undefined ? { size: draft.size } : {}), ...(draft.width ? { width: draft.width } : {}), ...(draft.height ? { height: draft.height } : {}) }]
			: [],
	);
}
