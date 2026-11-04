// Só exibição: imagens seguidas no fio viram UM cartão (um leque). Roda DEPOIS do merge ao vivo/persistido; o dedupe
// (`imagesSignature`, chat-thread) continua por evento, então nada aqui duplica nem perde imagem.
import type { ChatItem } from "./chat-types";

type ImagesItem = Extract<ChatItem, { kind: "images" }>;

/** Não aparece no fio: fala do assistente sem texto (os demais tipos sempre desenham algo). */
function isInvisible(item: ChatItem): boolean {
	return item.kind === "assistant" && !item.text.trim();
}

/**
 * Funde itens `images` consecutivos da mesma origem (lado) num só. O texto do assistente, a fala do usuário, outro
 * cartão ou marcador quebram o grupo; item invisível no meio não. O id do fundido é o do primeiro (estável quando chega
 * a próxima imagem, a lista não pisca). Legenda: a primeira não vazia: juntar legendas de eventos diferentes viraria um
 * texto longo e repetido embaixo do leque. Quem não tem vizinho de imagem sai idêntico (mesma referência).
 */
export function groupConsecutiveImages(items: readonly ChatItem[]): ChatItem[] {
	const out: ChatItem[] = [];
	// Posição, em `out`, do último cartão de imagens ainda aberto (nada visível entre ele e o item atual).
	let open = -1;
	for (const item of items) {
		if (item.kind === "images") {
			const head = open >= 0 ? (out[open] as ImagesItem) : undefined;
			if (head && head.origin === item.origin) {
				out[open] = { ...head, images: [...head.images, ...item.images], ...(head.caption || !item.caption ? {} : { caption: item.caption }) };
				continue;
			}
			out.push(item);
			open = out.length - 1;
			continue;
		}
		if (!isInvisible(item)) open = -1;
		out.push(item);
	}
	return out;
}
