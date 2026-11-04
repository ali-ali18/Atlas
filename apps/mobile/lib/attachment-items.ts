// O que o fio mostra assim que o usuário envia anexos, antes de o servidor gravar: o cartão de imagens (com a `uri`
// local, sem baixar nada) e o cartão de arquivo. Têm a mesma identidade dos gravados (`artifactId`), então o merge
// (`reconcile`) troca um pelo outro sem mostrar os dois.
import type { OutgoingAttachment } from "./attachments";
import type { ChatImage, ChatItem } from "./chat-types";

/** Lado assumido quando o seletor não informou as dimensões (só a proporção da miniatura depende disso). */
const FALLBACK_EDGE = 320;

export function optimisticAttachmentItems(baseId: string, attachments: readonly OutgoingAttachment[], createdAt: string): ChatItem[] {
	const images: ChatImage[] = attachments
		.filter((item) => item.route === "image")
		.map((item) => ({ artifactId: item.artifactId, mime: item.mime, width: item.width ?? FALLBACK_EDGE, height: item.height ?? FALLBACK_EDGE, name: item.name, uri: item.uri }));
	const items: ChatItem[] = [];
	if (images.length > 0) items.push({ id: `${baseId}-images`, kind: "images", origin: "user", images, createdAt });
	for (const item of attachments) {
		if (item.route !== "file") continue;
		items.push({
			id: `${baseId}-file-${item.artifactId}`,
			kind: "web-card",
			card: "file",
			title: item.name,
			key: `file:${item.artifactId}`,
			fileId: item.artifactId,
			mime: item.mime,
			...(item.size !== undefined ? { size: item.size } : {}),
			createdAt,
		});
	}
	return items;
}
