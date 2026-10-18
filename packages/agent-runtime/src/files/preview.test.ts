import { describe, expect, it } from "vitest";
import { parseCreateFileArgs } from "@workspace/shared";
import { buildFilePreview, parseDelimited } from "./preview.js";
import { renderFile } from "./render.js";

async function make(args: Record<string, unknown>) {
	const input = parseCreateFileArgs(args);
	const out = await renderFile(input, { printPdf: async () => new TextEncoder().encode("%PDF") });
	return { filename: input.filename, bytes: out.bytes };
}

describe("buildFilePreview", () => {
	it("docx vira html sanitizado com tabela", async () => {
		const file = await make({ filename: "a.docx", content: "# Título\n\n| A | B |\n|---|---|\n| 1 | 2 |\n" });
		const preview = await buildFilePreview({ id: "x1", ...file });
		expect(preview.kind).toBe("html");
		if (preview.kind === "html") {
			expect(preview.html).toContain("Título");
			expect(preview.html).toContain("<table>");
			expect(preview.html).not.toContain("<script");
		}
	});

	it("xlsx vira abas com linhas (fórmula mostra o texto)", async () => {
		const file = await make({
			filename: "p.xlsx",
			sheets: [{ name: "Preços", columns: ["Item", "Valor"], rows: [["A", 10], ["B", "=B2*2"]] }],
		});
		const preview = await buildFilePreview({ id: "x2", ...file });
		expect(preview.kind).toBe("sheets");
		if (preview.kind === "sheets") {
			expect(preview.sheets[0]?.name).toBe("Preços");
			expect(preview.sheets[0]?.rows[0]).toEqual(["Item", "Valor"]);
			expect(preview.sheets[0]?.rows[1]).toEqual(["A", "10"]);
			expect(preview.sheets[0]?.rows[2]?.[1]).toBe("=B2*2");
		}
	});

	it("limita linhas da planilha em 500", async () => {
		const rows = Array.from({ length: 700 }, (_, i) => [i]);
		const file = await make({ filename: "g.xlsx", sheets: [{ name: "S", rows }] });
		const preview = await buildFilePreview({ id: "x3", ...file });
		if (preview.kind !== "sheets") throw new Error("esperava sheets");
		expect(preview.sheets[0]?.rows).toHaveLength(500);
		expect(preview.sheets[0]?.truncated).toBe(true);
	});

	it("código e texto trazem a linguagem; csv vira tabela", async () => {
		const py = await make({ filename: "r.py", content: "print(1)\n" });
		expect(await buildFilePreview({ id: "x4", ...py })).toMatchObject({ kind: "text", text: "print(1)\n", language: "python" });
		const csv = await make({ filename: "d.csv", content: 'a,b\n1,"x,y"\n' });
		const preview = await buildFilePreview({ id: "x5", ...csv });
		expect(preview).toMatchObject({ kind: "sheets" });
		if (preview.kind === "sheets") expect(preview.sheets[0]?.rows[1]).toEqual(["1", "x,y"]);
	});

	it("pdf aponta para a URL inline autenticada; pptx sem prévia", async () => {
		const pdf = await make({ filename: "a.pdf", content: "x" });
		expect(await buildFilePreview({ id: "abc", ...pdf })).toEqual({ kind: "url", url: "/v1/files/abc?inline=1" });
		const pptx = await make({ filename: "a.pptx", slides: [{ title: "t", bullets: [] }] });
		expect((await buildFilePreview({ id: "p", ...pptx })).kind).toBe("none");
	});
});

describe("parseDelimited", () => {
	it("aspas escapadas e quebra de linha CRLF", () => {
		expect(parseDelimited('a,"b ""c"""\r\n1,2', ",")).toEqual([["a", 'b "c"'], ["1", "2"]]);
	});
});
