// Imagens coladas no campo (área de transferência, sugestão do teclado, GIF/figurinha): decisão pura do que vira anexo.
// O módulo nativo entrega só `file://` temporários, sem MIME; o tipo sai da extensão e a validação (formato, limites) fica em
// `attachments.ts`, o mesmo caminho das fotos escolhidas na galeria.
import { fileExtension } from "@workspace/shared";
import type { PickedFile } from "./attachments";

/** Formato do evento `onPaste` do `expo-paste-input` (só o que usamos). */
export type PastePayload = { type: "text"; value: string } | { type: "images"; uris: string[] } | { type: "unsupported" };

const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif" };

/** Nome do arquivo temporário (último trecho do caminho, sem query). */
function baseName(uri: string): string {
	const path = uri.split(/[?#]/)[0] ?? "";
	const last = path.slice(path.lastIndexOf("/") + 1);
	try {
		return decodeURIComponent(last);
	} catch {
		return last;
	}
}

/** Converte as imagens coladas em itens comuns de anexo (`PickedFile`). Texto e tipos desconhecidos não geram nada. */
export function pickedFromPaste(payload: PastePayload): PickedFile[] {
	if (payload.type !== "images") return [];
	return payload.uris
		.filter((uri) => typeof uri === "string" && uri.length > 0)
		.map((uri) => {
			const name = baseName(uri);
			const mime = MIME_BY_EXT[fileExtension(name)];
			// Sem extensão reconhecida: cai em `image/jpeg` (o módulo nativo só salva png/jpg/gif); a validação confere o resto.
			return { uri, name, mime: mime ?? "image/jpeg" };
		});
}
