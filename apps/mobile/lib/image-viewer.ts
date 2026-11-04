// Visualizador de imagens do chat: lógica pura (coleta das imagens do fio, legenda, índice, tamanho, URLs seguras).
// Nada aqui toca em React nem em módulo nativo; a tela fica em `components/image-viewer/`.
import type { ChatImage, ChatItem } from "./chat-types";

/** Uma imagem do visualizador, na ordem do fio. `key` é única (mesmo arquivo repetido aparece uma vez só). */
export type ViewerImage = ChatImage & { key: string; caption?: string };

const CAPTION_MAX = 160;

/** Texto em uma linha, sem quebra nem espaço repetido, cortado com reticências; vazio vira `undefined`. */
export function shortCaption(text: string | undefined, max = CAPTION_MAX): string | undefined {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Legenda da imagem: a descrição (alt) dela; senão a legenda do cartão; senão, no anexo do usuário, o texto da fala
 * colada ao cartão (a anterior, ou a seguinte quando o cartão vem primeiro). Sem nada disso, sem legenda.
 */
export function imageCaption(image: ChatImage, card: Extract<ChatItem, { kind: "images" }>, previous?: ChatItem, next?: ChatItem): string | undefined {
	const own = shortCaption(image.alt) ?? shortCaption(card.caption);
	if (own) return own;
	if (card.origin !== "user") return undefined;
	const neighbour = previous?.kind === "user" ? previous : next?.kind === "user" ? next : undefined;
	return neighbour ? shortCaption(neighbour.text) : undefined;
}

/**
 * TODAS as imagens da conversa na ordem do fio (anexos do usuário e imagens do bot). Mesmo arquivo em mais de um cartão
 * (ao vivo e gravado, reenvio) conta uma vez, na primeira posição; se a primeira vez não tinha legenda e a seguinte
 * tem, fica a legenda que existe.
 */
export function collectViewerImages(items: readonly ChatItem[]): ViewerImage[] {
	const out: ViewerImage[] = [];
	const seen = new Map<string, number>();
	items.forEach((item, index) => {
		if (item.kind !== "images") return;
		for (const image of item.images) {
			const caption = imageCaption(image, item, items[index - 1], items[index + 1]);
			const at = seen.get(image.artifactId);
			if (at !== undefined) {
				const known = out[at];
				if (known && !known.caption && caption) out[at] = { ...known, caption };
				continue;
			}
			seen.set(image.artifactId, out.length);
			out.push({ ...image, key: image.artifactId, ...(caption ? { caption } : {}) });
		}
	});
	return out;
}

/** Posição da imagem tocada na lista; id que não está lá (ou vazio) abre na primeira. */
export function viewerStartIndex(images: readonly ViewerImage[], artifactId: string | null | undefined): number {
	if (!artifactId) return 0;
	const at = images.findIndex((image) => image.artifactId === artifactId);
	return at >= 0 ? at : 0;
}

/** Índice limitado a [0, total - 1]; sem imagens, 0. */
export function clampIndex(index: number, total: number): number {
	if (!Number.isFinite(index) || total <= 0) return 0;
	return Math.min(Math.max(Math.round(index), 0), total - 1);
}

/**
 * A lista de imagens mudou com o visualizador aberto: o índice segue a imagem que a pessoa estava vendo (pela chave); se
 * ela sumiu, fica no mais próximo da posição antiga. Sem imagens, 0.
 */
export function revalidateIndex(images: readonly { key: string }[], currentKey: string | undefined, previousIndex: number): number {
	if (images.length === 0) return 0;
	const at = currentKey === undefined ? -1 : images.findIndex((image) => image.key === currentKey);
	return at >= 0 ? at : clampIndex(previousIndex, images.length);
}

/** Página atual de um pager horizontal pela posição da rolagem. */
export function indexFromOffset(offsetX: number, pageWidth: number, total: number): number {
	if (!(pageWidth > 0)) return 0;
	return clampIndex(offsetX / pageWidth, total);
}

/** Caminho (relativo ao servidor) do arquivo da imagem; o servidor filtra pelo dono da sessão. */
export function imageApiPath(artifactId: string): string {
	return `/v1/files/${encodeURIComponent(artifactId)}`;
}

/**
 * `uri` local aceita: `data:image/<tipo permitido>;base64,`, `file:` e http(s). Qualquer outro esquema
 * (`javascript:`, `content:`, `intent:`, `data:text/html`…) é recusado.
 */
export function isSafeImageUri(uri: string | undefined | null): uri is string {
	if (!uri || uri.length > 12 * 1024 * 1024) return false;
	if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(uri)) return true;
	return /^(https?|file):\/\/[^\s]+$/i.test(uri);
}

/** Imagem desenhada: a `uri` local quando é segura; senão `null` (quem chama baixa pelo servidor com a sessão). */
export function localImageUri(image: Pick<ChatImage, "uri">): string | null {
	return isSafeImageUri(image.uri) ? image.uri : null;
}

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** Nome do arquivo ao compartilhar ou salvar: o nome do anexo (sem caminho) com a extensão do tipo, ou "imagem-<id>". */
export function imageFileName(image: Pick<ChatImage, "artifactId" | "mime" | "name">): string {
	const extension = EXTENSION[image.mime] ?? "png";
	const base = (image.name ?? "").split(/[\\/]/).pop()?.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
	return `${base || `imagem-${image.artifactId.replace(/[^\w-]/g, "").slice(0, 12) || "x"}`}.${extension}`;
}

/** Tamanho da imagem dentro da caixa, sem cortar (contain; imagem pequena cresce até caber). Dimensão inválida = caixa inteira. */
export function fitImage(width: number, height: number, boxWidth: number, boxHeight: number): { width: number; height: number } {
	if (!(boxWidth > 0) || !(boxHeight > 0)) return { width: 0, height: 0 };
	if (!(width > 0) || !(height > 0)) return { width: boxWidth, height: boxHeight };
	const scale = Math.min(boxWidth / width, boxHeight / height);
	return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Quantas cartas entram no leque do chat: a da frente e até 2 atrás. */
export const FAN_MAX = 3;

/** Rotação (graus) de cada carta de trás; a primeira é a mais próxima da frente. */
export const FAN_ROTATIONS = [4, 8] as const;

/** Cartas do leque: a imagem da frente (a primeira do cartão) e até 2 atrás, na ordem. Vazio = sem leque. */
export function fanImages<T>(images: readonly T[]): { front: T; behind: T[] } | null {
	const [front, ...rest] = images;
	if (front === undefined) return null;
	return { front, behind: rest.slice(0, FAN_MAX - 1) };
}

/** Texto embaixo do leque: "2 imagens" (o singular só existe por completude: uma imagem não vira leque). */
export function imagesCountLabel(count: number): string {
	const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
	return `${n} ${n === 1 ? "imagem" : "imagens"}`;
}

/** Proporção (largura/altura) da imagem única no chat, limitada para não virar faixa nem torre. */
export function singleImageAspect(width: number, height: number): number {
	if (!(width > 0) || !(height > 0)) return 1;
	return Math.min(Math.max(width / height, 0.6), 1.6);
}
