import { describe, expect, it } from "vitest";
import type { NotebookEntry } from "@workspace/shared";
import { DOC_WORDS_THRESHOLD, asksForDocument, countWords, needsDocumentDelivery, withNotebookAppendix } from "./delivery.js";

const words = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`).join(" ");
const entry = (partial: Partial<NotebookEntry> & Pick<NotebookEntry, "id" | "title">): NotebookEntry => ({ kind: "finding", excerpt: "x", author: "coordinator", step: 0, ...partial });

describe("entrega em documento", () => {
	it("resposta acima de ~1.500 palavras vira documento; abaixo, só se o pedido for de relatório com trabalho feito", () => {
		expect(countWords(words(10))).toBe(10);
		expect(needsDocumentDelivery({ text: words(DOC_WORDS_THRESHOLD + 1), request: "oi", hasFile: false, notebookCount: 0 })).toBe(true);
		expect(needsDocumentDelivery({ text: words(DOC_WORDS_THRESHOLD), request: "oi", hasFile: false, notebookCount: 0 })).toBe(false);
		expect(needsDocumentDelivery({ text: words(50), request: "Faça um relatório de preços", hasFile: false, notebookCount: 3 })).toBe(true);
		expect(needsDocumentDelivery({ text: words(350), request: "Faça uma análise do mercado", hasFile: false, notebookCount: 0 })).toBe(true);
		// "o relatório ficou pronto" (curto, sem caderno) não vira documento
		expect(needsDocumentDelivery({ text: words(20), request: "Faça um relatório de preços", hasFile: false, notebookCount: 0 })).toBe(false);
	});

	it("com arquivo já entregue nunca dispara de novo", () => {
		expect(needsDocumentDelivery({ text: words(3000), request: "relatório", hasFile: true, notebookCount: 5 })).toBe(false);
	});

	it("reconhece o pedido de relatório, estudo e análise em pt, en e es", () => {
		for (const request of ["Quero um RELATÓRIO", "um estudo de mercado", "faça a análise", "write a report", "a market study", "an analysis please", "necesito un análisis"]) expect(asksForDocument(request), request).toBe(true);
		for (const request of ["Bom dia", "quanto custa o frete?", "me lembra amanhã"]) expect(asksForDocument(request), request).toBe(false);
	});
});

describe("withNotebookAppendix", () => {
	const entries = [
		entry({ id: "n1", title: "Forn A", source: "https://a.com/p" }),
		entry({ id: "n2", title: "Forn B", source: "https://b.com/p" }),
		entry({ id: "n3", title: "Forn C: could not confirm", kind: "unconfirmed", excerpt: "site fora do ar" }),
	];

	it("acrescenta as fontes do caderno que o texto não cita e o que não foi confirmado, no idioma do bot", () => {
		const out = withNotebookAppendix({ filename: "r.md", content: "# R\n\nA em https://a.com/p" }, entries, "pt-BR");
		const content = out.content as string;
		expect(content).toContain("## Fontes");
		expect(content).toContain("- https://b.com/p");
		expect(content.split("https://a.com/p").length - 1).toBe(1);
		expect(content).toContain("## Não deu para confirmar");
		expect(content).toContain("- Forn C: could not confirm: site fora do ar");
		expect(withNotebookAppendix({ filename: "r.md", content: "x" }, entries, "en-US").content).toContain("## Could not confirm");
	});

	it("não mexe em planilha, apresentação, código, arquivo em partes e documento que já cita tudo", () => {
		for (const filename of ["p.xlsx", "d.pptx", "s.py"]) expect(withNotebookAppendix({ filename, content: "x" }, entries, "pt-BR").content).toBe("x");
		expect(withNotebookAppendix({ filename: "r.md", content: "x", part: 1, more: true }, entries, "pt-BR").content).toBe("x");
		const complete = "https://a.com/p https://b.com/p Forn C: could not confirm";
		expect(withNotebookAppendix({ filename: "r.md", content: complete }, entries, "pt-BR").content).toBe(complete);
		expect(withNotebookAppendix({ filename: "r.md", content: "x" }, [], "pt-BR").content).toBe("x");
	});
});
