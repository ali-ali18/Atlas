import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chat-types";
import { pageCardSummary, pageRouteFor } from "./web-card";

type WebCard = Extract<ChatItem, { kind: "web-card" }>;
const card = (extra: Partial<WebCard> = {}): WebCard => ({ id: "1", kind: "web-card", card: "page", title: "Vendas & metas", key: "page:p 1", ...extra });

describe("destino do cartão de painel", () => {
	it("com pageId abre a tela nativa (id e título codificados)", () => {
		expect(pageRouteFor(card({ pageId: "p 1" }))).toBe("/pages/p%201?title=Vendas%20%26%20metas");
	});
	it("cartão antigo, sem pageId, continua no navegador", () => {
		expect(pageRouteFor(card())).toBeNull();
		expect(pageRouteFor(card({ pageId: "" }))).toBeNull();
	});
	it("só painel abre a tela de painel, mesmo que outro cartão traga pageId", () => {
		expect(pageRouteFor(card({ card: "chart", pageId: "p1" }))).toBeNull();
	});
	it("resumo com número de fontes", () => {
		expect(pageCardSummary(card())).toBe("Painel");
		expect(pageCardSummary(card({ sourceCount: 1 }))).toBe("Painel · 1 fonte");
		expect(pageCardSummary(card({ sourceCount: 3 }))).toBe("Painel · 3 fontes");
	});
});
