// De onde vem o que a tela desenha de uma imagem do chat. Local seguro (`data:`, `file:`, http(s)) usa a própria `uri`;
// o resto é o arquivo do servidor (`GET /v1/files/:id`), baixado com a sessão e guardado em memória (poucas, as mais
// recentes) para a miniatura, o cartão e o visualizador não baixarem a mesma imagem três vezes.
import type { ChatImage } from "./chat-types";
import { imageDataUri, MAX_IMAGE_BYTES, MAX_SHARE_BYTES } from "./document-view";
import { downloadFile } from "./file-api";
import type { ApiFetch } from "./home-sync";
import { localImageUri } from "./image-viewer";

/**
 * Cache LRU com teto por PESO (`weigh`; padrão 1 por item): o mais antigo sai ao passar do teto e ler renova. Item mais
 * pesado que o teto inteiro nem entra (não expulsa os outros à toa).
 */
export function createLruCache<T>(maxWeight: number, weigh: (value: T) => number = () => 1) {
	const map = new Map<string, { value: T; weight: number }>();
	let total = 0;
	return {
		get(key: string): T | undefined {
			const entry = map.get(key);
			if (entry === undefined) return undefined;
			map.delete(key);
			map.set(key, entry);
			return entry.value;
		},
		set(key: string, value: T): void {
			const previous = map.get(key);
			if (previous) total -= previous.weight;
			map.delete(key);
			const weight = weigh(value);
			if (weight > maxWeight) return;
			map.set(key, { value, weight });
			total += weight;
			while (total > maxWeight) {
				const oldest = map.keys().next().value;
				if (oldest === undefined) break;
				total -= map.get(oldest)?.weight ?? 0;
				map.delete(oldest);
			}
		},
		get size() {
			return map.size;
		},
		get weight() {
			return total;
		},
	};
}

/** Teto da memória das imagens abertas, em bytes (o `data:` URI conta pelo tamanho do texto): 40 MB no total, não por imagem. */
export const IMAGE_MEMORY_BYTES = 40 * 1024 * 1024;

export function createImageLoader(maxBytes = IMAGE_MEMORY_BYTES) {
	const cache = createLruCache<string>(maxBytes, (uri) => uri.length);
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
