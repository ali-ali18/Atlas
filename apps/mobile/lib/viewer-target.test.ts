import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chat-types";
import type { LibraryItem } from "./library-items";
import { viewerTargetForCard, viewerTargetForLibraryItem } from "./viewer-target";

type WebCard = Extract<ChatItem, { kind: "web-card" }>;
const card = (extra: Partial<WebCard> = {}): WebCard => ({ id: "1", kind: "web-card", card: "page", title: "Plano", key: "k", ...extra });
const item = (extra: Partial<LibraryItem> = {}): LibraryItem => ({ key: "k", source: "file", id: "f1", kind: "document", title: "a.md", date: "2026-10-01T10:00:00Z", ...extra });

describe("destino do toque no cartão do chat", () => {
	it("painel com pageId abre a folha do painel", () => {
		expect(viewerTargetForCard(card({ pageId: "p1" }))).toEqual({ kind: "page", id: "p1", title: "Plano" });
	});
	it("arquivo com fileId abre a folha do documento, com mime e tamanho quando há", () => {
		expect(viewerTargetForCard(card({ card: "file", title: "a.md", fileId: "f1", mime: "text/markdown", size: 120 }))).toEqual({ kind: "file", id: "f1", filename: "a.md", mime: "text/markdown", size: 120 });
		expect(viewerTargetForCard(card({ card: "file", title: "a.md", fileId: "f1" }))).toEqual({ kind: "file", id: "f1", filename: "a.md" });
	});
	it("cartão antigo (sem id) e outros cartões continuam no navegador", () => {
		expect(viewerTargetForCard(card())).toBeNull();
		expect(viewerTargetForCard(card({ card: "file", title: "a.md" }))).toBeNull();
		expect(viewerTargetForCard(card({ card: "chart", pageId: "p1", fileId: "f1" }))).toBeNull();
		expect(viewerTargetForCard(card({ card: "approval" }))).toBeNull();
	});
});

describe("destino do toque na Biblioteca", () => {
	it("painel abre a folha do painel", () => {
		expect(viewerTargetForLibraryItem(item({ source: "panel", id: "p1", kind: "panel", title: "Vendas" }))).toEqual({ kind: "page", id: "p1", title: "Vendas" });
	});
	it("documento abre a folha do documento (nunca o navegador)", () => {
		expect(viewerTargetForLibraryItem(item({ mime: "text/markdown", size: 10 }))).toEqual({ kind: "file", id: "f1", filename: "a.md", mime: "text/markdown", size: 10 });
		expect(viewerTargetForLibraryItem(item())).toEqual({ kind: "file", id: "f1", filename: "a.md" });
	});
});
