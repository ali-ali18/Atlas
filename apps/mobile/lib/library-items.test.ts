import { describe, expect, it } from "vitest";
import { libraryItemKind, libraryKindLabel, mergeLibraryItems } from "./library-items";

describe("libraryItemKind", () => {
	it("classifica pelo mime", () => {
		expect(libraryItemKind("application/pdf")).toBe("document");
		expect(libraryItemKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("document");
		expect(libraryItemKind("text/markdown")).toBe("document");
		expect(libraryItemKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("sheet");
		expect(libraryItemKind("application/vnd.ms-excel")).toBe("sheet");
		expect(libraryItemKind("text/csv")).toBe("sheet");
		expect(libraryItemKind("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("presentation");
		expect(libraryItemKind("IMAGE/PNG")).toBe("image");
	});
	it("mime genérico ou vazio usa a extensão; sem pista é arquivo", () => {
		expect(libraryItemKind("application/octet-stream", "Planilha de custos.xlsx")).toBe("sheet");
		expect(libraryItemKind("", "foto.JPG")).toBe("image");
		expect(libraryItemKind("application/zip", "pacote.zip")).toBe("file");
		expect(libraryItemKind("")).toBe("file");
	});
	it("rótulos em pt-BR (painel nunca 'página')", () => {
		expect(libraryKindLabel("panel")).toBe("Painel");
		expect(libraryKindLabel("sheet")).toBe("Planilha");
		expect(libraryKindLabel("document")).toBe("Documento");
	});
});

describe("mergeLibraryItems", () => {
	const files = [
		{ id: "f1", filename: "a.pdf", size: 1, version: 1, mime: "application/pdf", createdAt: "2026-11-01T10:00:00.000Z" },
		{ id: "f2", filename: "sem-data.pdf", size: 1, version: 1, mime: "application/pdf", createdAt: "lixo" },
	];
	const panels = [{ id: "p1", title: "Vendas", updatedAt: "2026-11-02T10:00:00.000Z" }];
	it("ordena por data desc, mistura os dois e manda data inválida para o fim", () => {
		const items = mergeLibraryItems(files, panels);
		expect(items.map((item) => item.key)).toEqual(["panel:p1", "file:f1", "file:f2"]);
		expect(items[0]).toMatchObject({ kind: "panel", title: "Vendas", source: "panel" });
	});
	it("ids iguais em origens diferentes não colidem na chave", () => {
		const items = mergeLibraryItems([{ ...files[0]!, id: "x" }], [{ ...panels[0]!, id: "x" }]);
		expect(new Set(items.map((item) => item.key)).size).toBe(2);
	});
});
