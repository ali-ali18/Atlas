// De onde vem o que a tela desenha de uma imagem do chat. Local seguro (`data:`, `file:`, http(s)) usa a própria `uri`;
// o resto é o arquivo do servidor (`GET /v1/files/:id`), baixado com a sessão e guardado em memória (poucas, as mais
// recentes) para a miniatura, o cartão e o visualizador não baixarem a mesma imagem três vezes.
import type { ChatImage } from "./chat-types";
import { imageDataUri, MAX_IMAGE_BYTES, MAX_SHARE_BYTES } from "./document-view";
import { downloadFile } from "./file-api";
import type { ApiFetch } from "./home-sync";
import { localImageUri } from "./image-viewer";

/** Cache LRU simples (o mais antigo sai ao passar do limite; ler renova). */
export function createLruCache<T>(max: number) {
	const map = new Map<string, T>();
	return {
		get(key: string): T | undefined {
			const value = map.get(key);
			if (value === undefined) return undefined;
			map.delete(key);
			map.set(key, value);
			return value;
		},
		set(key: string, value: T): void {
			map.delete(key);
			map.set(key, value);
			while (map.size > max) {
				const oldest = map.keys().next().value;
				if (oldest === undefined) break;
				map.delete(oldest);
			}
		},
		get size() {
			return map.size;
		},
	};
}

const MEMORY_IMAGES = 24;

export function createImageLoader(max = MEMORY_IMAGES) {
	const cache = createLruCache<string>(max);
	const inflight = new Map<string, Promise<string>>();
	return function load(apiFetch: ApiFetch, image: Pick<ChatImage, "artifactId" | "mime" | "uri">): Promise<string> {
		const local = localImageUri(image);
		if (local) return Promise.resolve(local);
		const hit = cache.get(image.artifactId);
		if (hit) return Promise.resolve(hit);
		const pending = inflight.get(image.artifactId);
		if (pending) return pending;
		const task = downloadFile(apiFetch, image.artifactId, MAX_IMAGE_BYTES)
			.then(({ bytes, mime }) => {
				const uri = imageDataUri(image.mime || mime, bytes);
				cache.set(image.artifactId, uri);
				return uri;
			})
			.finally(() => inflight.delete(image.artifactId));
		inflight.set(image.artifactId, task);
		return task;
	};
}

/** Carregador do app (um só, com a memória compartilhada entre cartão, miniaturas e visualizador). */
export const loadImageUri = createImageLoader();

/** Bytes da imagem para compartilhar ou salvar (arquivo de verdade; teto de compartilhar). Sempre do servidor. */
export function downloadImageBytes(apiFetch: ApiFetch, artifactId: string): Promise<{ bytes: Uint8Array; mime: string }> {
	return downloadFile(apiFetch, artifactId, MAX_SHARE_BYTES);
}
