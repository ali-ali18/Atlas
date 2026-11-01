import { describe, expect, it } from "vitest";
import { createNotebook } from "@workspace/shared";
import { NOTEBOOK_READ_TOOL, NOTEBOOK_WRITE_TOOL, executeNotebookRead, executeNotebookWrite } from "./notebook.js";

const coordinator = () => {
	const notebook = createNotebook();
	return { notebook, ctx: { notebook: { writer: notebook.writer("coordinator"), reader: notebook }, currentStep: () => 4 } };
};

describe("tools do caderno", () => {
	it("descrições dizem quando usar e quando não usar, em inglês", () => {
		expect(NOTEBOOK_WRITE_TOOL.function.description).toMatch(/USE WHEN/);
		expect(NOTEBOOK_WRITE_TOOL.function.description).toMatch(/DO NOT USE/);
		expect(NOTEBOOK_READ_TOOL.function.description).toMatch(/USE WHEN/);
	});

	it("grava e devolve resultado curto; o passo atual carimba a entrada", () => {
		const { notebook, ctx } = coordinator();
		expect(executeNotebookWrite({ title: "Forn A", excerpt: "R$ 10", source: "https://a.com" }, ctx).summary).toBe("Entry n1 saved (1/200).");
		expect(notebook.get("n1")).toMatchObject({ step: 4, author: "coordinator" });
		expect(executeNotebookWrite({ title: "Forn A", excerpt: "R$ 11", replaces: "n1" }, ctx).summary).toBe("Entry n2 replaced (1/200).");
	});

	it("erros honestos: excerpt grande, campo desconhecido, sem caderno", () => {
		const { ctx } = coordinator();
		expect(() => executeNotebookWrite({ title: "x", excerpt: "a".repeat(2001) }, ctx)).toThrow(/maximum is 2000/);
		expect(() => executeNotebookWrite({ title: "x", excerpt: "y", foo: 1 }, ctx)).toThrow(/Unknown field/);
		expect(() => executeNotebookWrite({ title: "x", excerpt: "y" }, {})).toThrow(/not available/);
	});

	it("ajudante só escreve: ler lança erro; o escritor dele carimba o autor", () => {
		const notebook = createNotebook();
		const helper = { notebook: { writer: notebook.writer("helper:2") } };
		executeNotebookWrite({ title: "Forn C", excerpt: "R$ 9" }, helper);
		expect(notebook.get("n1")?.author).toBe("helper:2");
		expect(() => executeNotebookRead({}, helper)).toThrow(/cannot read the notebook/);
	});

	it("leitura sob demanda: por id, por texto e com limite de entradas por chamada", () => {
		const { notebook, ctx } = coordinator();
		for (let i = 0; i < 12; i++) executeNotebookWrite({ title: `Item ${i}`, excerpt: `valor ${i}`, source: `https://s${i}.com` }, ctx);
		expect(executeNotebookRead({ ids: ["n3"] }, ctx).summary).toContain("valor 2");
		expect(executeNotebookRead({ query: "s7.com" }, ctx).summary).toContain("Item 7");
		const all = executeNotebookRead({}, ctx).summary;
		expect(all).toContain("8 of 12 matching entries");
		expect(all).toContain("(+4 more; narrow with ids or query)");
		expect(executeNotebookRead({ ids: ["n99"] }, ctx).summary).toMatch(/No matching entries \(the notebook has 12\)/);
		expect(() => executeNotebookRead({ kind: "nota" }, ctx)).toThrow(/kind must be/);
		expect(notebook.count()).toBe(12);
	});
});
