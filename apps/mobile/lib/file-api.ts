// Documentos do bot: `GET /v1/files/:id` (o mesmo endpoint do web; o servidor filtra pelo dono da sessão e responde 404
// para arquivo de outro dono). O app baixa só o que sabe desenhar (texto, CSV, JSON, código, imagem) e só até o teto;
// PDF, Office e afins não são baixados para ver (só para compartilhar, a pedido).
import { ChatApiError } from "./chat-api";
import {
	type DocumentViewKind,
	decodeUtf8,
	documentViewKind,
	imageDataUri,
	MAX_IMAGE_BYTES,
	MAX_SHARE_BYTES,
	MAX_VIEW_BYTES,
} from "./document-view";
import type { ApiFetch } from "./home-sync";

/** O arquivo passa do teto de tamanho (`limit` em bytes, `size` real quando o servidor avisa). */
export class FileTooLargeError extends Error {
	constructor(
		readonly limit: number,
		readonly size?: number,
	) {
		super("Documento grande demais");
	}
}

/** O que a folha precisa saber do arquivo antes de baixar (a Biblioteca sabe mime e tamanho; o cartão do chat, só o nome). */
export type FileTarget = { id: string; filename: string; mime?: string; size?: number };

export type TextView = Exclude<DocumentViewKind, "image" | "unsupported">;

export type DocumentContent =
	| { type: "text"; view: TextView; text: string }
	| { type: "image"; uri: string }
	| { type: "unsupported" }
	| { type: "too-large" };

const filePath = (id: string) => `/v1/files/${encodeURIComponent(id)}`;

/** Lê o corpo até `limit`: em pedaços, quando o motor de rede entrega `body` em stream (corta e cancela ao passar); senão, tudo de uma vez. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
	const reader = response.body?.getReader?.();
	if (!reader) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > limit) throw new FileTooLargeError(limit, bytes.byteLength);
		return bytes;
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			throw new FileTooLargeError(limit);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * Baixa os bytes, recusando acima de `limit`: pelo `Content-Length` antes de ler e, sem ele, lendo em stream e cortando
 * ao passar do teto (o `fetch` global do RN não expõe `body`; aí cai no `arrayBuffer`, e o servidor é o do próprio dono).
 */
export async function downloadFile(apiFetch: ApiFetch, id: string, limit: number): Promise<{ bytes: Uint8Array; mime: string }> {
	const response = await apiFetch(filePath(id));
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) throw new FileTooLargeError(limit, declared);
	const bytes = await readCapped(response, limit);
	return { bytes, mime: response.headers.get("content-type") ?? "" };
}

/** Baixa e prepara o conteúdo para a folha. Não baixa o que não dá para ver nem o que já se sabe grande demais. */
export async function fetchDocument(apiFetch: ApiFetch, target: FileTarget): Promise<DocumentContent> {
	const view = documentViewKind(target.mime ?? "", target.filename);
	if (view === "unsupported") return { type: "unsupported" };
	const limit = view === "image" ? MAX_IMAGE_BYTES : MAX_VIEW_BYTES;
	if (target.size !== undefined && target.size > limit) return { type: "too-large" };
	try {
		const { bytes, mime } = await downloadFile(apiFetch, target.id, limit);
		if (view === "image") return { type: "image", uri: imageDataUri(target.mime || mime, bytes) };
		return { type: "text", view, text: decodeUtf8(bytes) };
	} catch (error) {
		if (error instanceof FileTooLargeError) return { type: "too-large" };
		throw error;
	}
}

/** Baixa o arquivo inteiro para compartilhar (teto maior que o da leitura). */
export function downloadForShare(apiFetch: ApiFetch, id: string): Promise<{ bytes: Uint8Array; mime: string }> {
	return downloadFile(apiFetch, id, MAX_SHARE_BYTES);
}

/** Frase simples para o erro (sem texto técnico). */
export function fileErrorText(error: unknown): string {
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.status === 404) return "Este documento não existe mais.";
		return "Não consegui abrir este documento agora.";
	}
	if (error instanceof FileTooLargeError) return "Documento grande demais para abrir aqui.";
	// Falha de rede no RN chega como TypeError: é "sem conexão", não erro do servidor.
	return "Sem conexão com o seu servidor. Tente de novo.";
}

/** Tentar de novo só faz sentido quando o documento pode voltar (rede, servidor); "não existe mais" e sessão não. */
export function fileErrorRetryable(error: unknown): boolean {
	return !(error instanceof ChatApiError && (error.status === 404 || error.status === 401));
}
