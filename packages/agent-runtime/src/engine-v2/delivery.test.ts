import { describe, expect, it } from "vitest";
import { FILE_MAX_CONTENT_CHARS, type NotebookEntry } from "@workspace/shared";
import { isFinalDeliverableCall, DOCUMENT_BUDGET_NOTE, DOCUMENT_STOPPED_NOTE, UNCONFIRMED_NOTE_MAX_LINES, documentStopNote, withNotebookAppendix } from "./delivery.js";
import { deliveryInstruction } from "./supervisor.js";

const entry = (partial: Partial<NotebookEntry> & Pick<NotebookEntry, "id" | "title">): NotebookEntry => ({ kind: "finding", excerpt: "x", author: "coordinator", step: 0, ...partial });

describe("regex fora do documento (decisão do dono, 03/11)", () => {
	it("delivery.ts não exporta mais detector de pedido de documento nem portão por tamanho", async () => {
		const module = (await import("./delivery.js")) as Record<string, unknown>;
		for (const name of ["asksForDocument", "declinesDocument", "needsDocumentDelivery", "DOCUMENT_DELIVERY_NOTE", "DOC_WORDS_THRESHOLD"]) expect(name in module, name).toBe(false);
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

	it("fonte já citada em parte anterior do arquivo não se repete (dedupe contra o conteúdo inteiro)", () => {
		const out = withNotebookAppendix({ filename: "r.md", content: "fim", part: 2, more: false }, entries, "pt-BR", "parte 1 cita https://a.com/p e https://b.com/p");
		expect(out.content as string).not.toContain("## Fontes");
		expect(out.content as string).toContain("## Não deu para confirmar");
	});

	it("apêndice cabe no limite do arquivo: fontes que sobram viram '… e mais N fontes' e os não confirmados entram todos", () => {
		const many = Array.from({ length: 4_000 }, (_, i) => entry({ id: `n${i + 1}`, title: `Fonte ${i}`, source: `https://exemplo${i}.com/${"p".repeat(80)}` }));
		const lost = [entry({ id: "u1", title: "Forn X", kind: "unconfirmed", excerpt: "fora do ar" }), entry({ id: "u2", title: "Forn Y", kind: "unconfirmed", excerpt: "sem preço" })];
		const content = "a".repeat(FILE_MAX_CONTENT_CHARS - 20_000);
		const out = withNotebookAppendix({ filename: "r.md", content }, [...many, ...lost], "pt-BR").content as string;
		expect(out.length).toBeLessThanOrEqual(FILE_MAX_CONTENT_CHARS);
		expect(out).toMatch(/… e mais \d+ fontes/);
		expect(out).toContain("- Forn X: fora do ar");
		expect(out).toContain("- Forn Y: sem preço");
	});

	it("a nota de não confirmado no fim é curta: poucas linhas, cada uma enxuta, o resto vira '… e mais N'", () => {
		const gaps = Array.from({ length: 10 }, (_, i) => entry({ id: `u${i}`, title: `Item ${i}`, kind: "unconfirmed", excerpt: "x".repeat(400) }));
		const out = withNotebookAppendix({ filename: "r.md", content: "corpo" }, gaps, "pt-BR").content as string;
		const note = out.split("## Não deu para confirmar")[1]!.trim().split("\n");
		expect(note.length).toBeLessThanOrEqual(UNCONFIRMED_NOTE_MAX_LINES + 1);
		expect(note.every((line) => line.length <= 170)).toBe(true);
		expect(note.at(-1)).toBe("… e mais 4 itens não confirmados");
	});

	it("a instrução de entrega manda uma nota curta no fim, não 'não confirmado' item a item no corpo", () => {
		expect(DOCUMENT_BUDGET_NOTE).toMatch(/one short closing note at the end/);
		expect(deliveryInstruction("budget_cost")).toMatch(/one short note at the end, not item by item/);
	});
});

describe("isFinalDeliverableCall", () => {
	it("só a última parte de um entregável conta; parte e arquivo auxiliar não", () => {
		expect(isFinalDeliverableCall({ filename: "r.pdf", content: "x" })).toBe(true);
		expect(isFinalDeliverableCall({ filename: "r.md", content: "x", more: false })).toBe(true);
		expect(isFinalDeliverableCall({ filename: "dados.xlsx" })).toBe(true);
		expect(isFinalDeliverableCall({ filename: "r.pdf", content: "x", more: true })).toBe(false);
		for (const aux of ["dados.csv", "grafico.png", "config.json", "script.py", ""]) expect(isFinalDeliverableCall({ filename: aux, content: "x" })).toBe(false);
		expect(isFinalDeliverableCall({ filename: "sem-extensao", format: "docx", content: "x" })).toBe(true);
	});
});

describe("nota de escrita do documento na parada, por motivo", () => {
	it("só budget_* usa a nota de teto; os outros motivos não falam em budget, limit nem time", () => {
		for (const reason of ["budget_cost", "budget_wall", "budget_steps"]) expect(documentStopNote(reason), reason).toBe(DOCUMENT_BUDGET_NOTE);
		for (const reason of ["loop_repeat", "tool_failures"]) {
			expect(documentStopNote(reason), reason).toBe(DOCUMENT_STOPPED_NOTE);
			expect(documentStopNote(reason), reason).not.toMatch(/\b(budget|limit|time|cap)\b/i);
		}
	});
});
