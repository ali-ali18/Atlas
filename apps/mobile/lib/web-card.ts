// Para onde o toque num cartão do fio leva. Painel com `pageId` abre a tela nativa; o resto (e painel gravado antes de
// o app guardar o id) continua indo ao navegador.
import type { ChatItem } from "./chat-types";
import { sourceCountLabel } from "./page-format";

type WebCard = Extract<ChatItem, { kind: "web-card" }>;

/** Caminho da tela nativa do painel (`/pages/<id>`), ou null se o cartão não é um painel com id. */
export function pageRouteFor(item: WebCard): string | null {
	if (item.card !== "page" || !item.pageId) return null;
	return `/pages/${encodeURIComponent(item.pageId)}?title=${encodeURIComponent(item.title)}`;
}

/** Resumo do cartão de painel: "Painel · 2 fontes" (ou só "Painel"). */
export function pageCardSummary(item: WebCard): string {
	return ["Painel", sourceCountLabel(item.sourceCount ?? 0)].filter(Boolean).join(" · ");
}
