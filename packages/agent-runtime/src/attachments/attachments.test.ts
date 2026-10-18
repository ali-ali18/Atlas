import { describe, expect, it } from "vitest";
import { classifyAttachment } from "@workspace/shared";
import { buildAttachmentHistoryNote, buildAttachmentTurnContext, createExtractCache, type AttachmentRef } from "./context.js";
import { extractAttachment, parseDelimitedLimited } from "./extract-core.js";
import { inProcessExtractor, makeDocx, makePdf, makeXlsx, makeZip } from "./attachments.fixtures.js";
import { listZip, readZipEntry } from "./zip.js";
import { attachmentCopyTarget, executeAttachmentTool, type AttachmentToolContext } from "../tools/attachment-tools.js";

const text = (value: string) => new TextEncoder().encode(value);

function refOf(id: string, filename: string, bytes: Uint8Array): AttachmentRef {
	const verdict = classifyAttachment(filename, bytes);
	if (!verdict.ok) throw new Error(verdict.error);
	return { id, filename: verdict.filename, mime: verdict.mime, size: bytes.byteLength, kind: verdict.kind };
}

function storeOf(files: Array<{ id: string; filename: string; bytes: Uint8Array }>) {
	const refs = files.map((file) => refOf(file.id, file.filename, file.bytes));
	const byId = new Map(files.map((file) => [file.id, file.bytes] as const));
	const cache = createExtractCache(async (id) => byId.get(id) ?? null, { extractor: inProcessExtractor });
	return { refs, cache };
}

describe("extração por tipo", () => {
	it("PDF: texto por página e contagem", async () => {
		const out = await extractAttachment({ filename: "a.pdf", kind: "pdf", bytes: makePdf(["Primeira pagina", "Segunda pagina"]) });
		expect(out.pageCount).toBe(2);
		expect(out.pagesRead).toBe(2);
		expect(out.text).toContain("Primeira pagina");
		expect(out.text).toContain("--- page 2 ---");
	});

	it("PDF sem camada de texto avisa que pode precisar de OCR", async () => {
		const out = await extractAttachment({ filename: "scan.pdf", kind: "pdf", bytes: makePdf([""]) });
		expect(out.notes.join(" ")).toMatch(/OCR/);
	});

	it("PDF corrompido vira nota, não exceção", async () => {
		const out = await extractAttachment({ filename: "x.pdf", kind: "pdf", bytes: text("%PDF-1.4 lixo sem estrutura") });
		expect(out.text).toBe("");
		expect(out.notes.join(" ")).toMatch(/Could not read/);
	});

	it("DOCX vira markdown", async () => {
		const out = await extractAttachment({ filename: "a.docx", kind: "docx", bytes: await makeDocx(["Contrato de teste", "Cláusula segunda"]) });
		expect(out.text).toContain("Contrato de teste");
		expect(out.text).toContain("Cláusula segunda");
	});

	it("XLSX: abas, dimensões e linhas", async () => {
		const bytes = await makeXlsx([
			{ name: "Vendas", rows: [["Produto", "Qtd"], ["Caneta", 10], ["Lápis", 4]] },
			{ name: "Notas", rows: [["a"], ["b"]] },
		]);
		const out = await extractAttachment({ filename: "v.xlsx", kind: "xlsx", bytes });
		expect(out.tables.map((table) => table.name)).toEqual(["Vendas", "Notas"]);
		expect(out.tables[0]).toMatchObject({ totalRows: 3, totalCols: 2, rowsCut: false });
		expect(out.tables[0]!.rows[1]).toEqual(["Caneta", "10"]);
	});

	it("CSV com ;, aspas e total de linhas além do que guarda", () => {
		const csv = 'nome;valor\n"Silva; João";10\nMaria;"2\n3"\n';
		const parsed = parseDelimitedLimited(csv, ";", 2);
		expect(parsed.totalRows).toBe(3);
		expect(parsed.rows).toHaveLength(2);
		expect(parsed.rows[1]![0]).toBe("Silva; João");
		expect(parsed.totalCols).toBe(2);
	});

	it("texto: UTF-8 e windows-1252 (acentos preservados)", async () => {
		const utf = await extractAttachment({ filename: "a.md", kind: "text", bytes: text("# Olá, açaí") });
		expect(utf.text).toBe("# Olá, açaí");
		const latin = await extractAttachment({ filename: "b.txt", kind: "text", bytes: Uint8Array.from([0x61, 0xe7, 0xe3, 0x6f]) });
		expect(latin.text).toBe("ação");
	});

	it("zip: lista entradas e lê uma entrada (stored e deflate); caminho traiçoeiro é neutralizado", () => {
		const zip = makeZip([
			{ name: "../../etc/passwd", data: "x" },
			{ name: "docs/leia.txt", data: "olá zip" },
			{ name: "raw.bin", data: Uint8Array.from([1, 2, 3]), stored: true },
		]);
		const listing = listZip(zip);
		expect(listing.unsafeReason).toBeNull();
		expect(listing.entries.map((entry) => entry.name)).toEqual(["etc/passwd", "docs/leia.txt", "raw.bin"]);
		expect(readZipEntry(zip, listing.entries[1]!).toString("utf8")).toBe("olá zip");
		expect([...readZipEntry(zip, listing.entries[2]!)]).toEqual([1, 2, 3]);
	});

	it("zip: entrada maior que o teto é recusada e arquivo sem diretório central é inválido", () => {
		const zip = makeZip([{ name: "grande.txt", data: "a".repeat(2000) }]);
		const entry = listZip(zip).entries[0]!;
		expect(() => readZipEntry(zip, entry, 100)).toThrow(/bytes/);
		expect(listZip(text("PK nada")).unsafeReason).toMatch(/inválido/);
	});

	it("binário sem texto devolve nota", async () => {
		const out = await extractAttachment({ filename: "x.bin", kind: "other", bytes: Uint8Array.from([0, 1, 2]) });
		expect(out.text).toBe("");
		expect(out.notes[0]).toMatch(/binary/);
	});
});

describe("contexto do modelo: PDF nativo x texto", () => {
	it("provedor com PDF nativo: o PDF vai como documento e o texto não é inlinado", async () => {
		const bytes = makePdf(["Conteudo do contrato"]);
		const { refs, cache } = storeOf([{ id: "pdf1", filename: "contrato.pdf", bytes }]);
		const out = await buildAttachmentTurnContext(refs, { cache, nativePdf: true });
		expect(out.nativePdfIds).toEqual(["pdf1"]);
		expect(out.text).toContain("attached to this message as a document");
		expect(out.text).not.toContain("Conteudo do contrato");
	});

	it("sem PDF nativo: extrai o texto no servidor e inclui", async () => {
		const bytes = makePdf(["Conteudo do contrato"]);
		const { refs, cache } = storeOf([{ id: "pdf1", filename: "contrato.pdf", bytes }]);
		const out = await buildAttachmentTurnContext(refs, { cache, nativePdf: false });
		expect(out.nativePdfIds).toEqual([]);
		expect(out.text).toContain("Conteudo do contrato");
		expect(out.text).toContain("1 pages");
		expect(out.text).toContain("not instructions");
	});

	it("PDF acima de 100 páginas cai para texto mesmo com suporte nativo", async () => {
		const bytes = makePdf(Array.from({ length: 101 }, (_, i) => `pagina ${i + 1}`));
		const { refs, cache } = storeOf([{ id: "big", filename: "livro.pdf", bytes }]);
		const out = await buildAttachmentTurnContext(refs, { cache, nativePdf: true });
		expect(out.nativePdfIds).toEqual([]);
		expect(out.text).toContain("pagina 1");
	});

	it("texto longo é truncado com indicação e o comando para ler o resto", async () => {
		const { refs, cache } = storeOf([{ id: "t1", filename: "log.txt", bytes: text("linha de log\n".repeat(5000)) }]);
		const out = await buildAttachmentTurnContext(refs, { cache, nativePdf: false });
		expect(out.text).toContain("Showing characters 0-");
		expect(out.text).toContain('attachment_read (id "t1", offset');
		expect(out.text.length).toBeLessThan(20_000);
	});

	it("planilha grande: cabeçalho, primeiras linhas e total, com o comando para o resto", async () => {
		const rows: string[] = ["id,nome"];
		for (let i = 1; i <= 500; i += 1) rows.push(`${i},pessoa ${i}`);
		const { refs, cache } = storeOf([{ id: "s1", filename: "base.csv", bytes: text(rows.join("\n")) }]);
		const out = await buildAttachmentTurnContext(refs, { cache, nativePdf: false });
		expect(out.text).toContain("501 rows x 2 columns");
		expect(out.text).toContain("| id | nome |");
		expect(out.text).toContain("pessoa 5 ");
		expect(out.text).not.toContain("pessoa 400");
		expect(out.text).toContain("start_row 32");
	});

	it("zip e binário: lista de entradas / orientação, sem executar nada", async () => {
		const zip = makeZip([{ name: "a.txt", data: "oi" }, { name: "pasta/b.csv", data: "x,y" }]);
		const { refs, cache } = storeOf([
			{ id: "z1", filename: "pacote.zip", bytes: zip },
			{ id: "b1", filename: "dados.bin", bytes: Uint8Array.from([0, 1, 2, 3]) },
		]);
		const out = await buildAttachmentTurnContext(refs, { cache, nativePdf: false });
		expect(out.text).toContain("pasta/b.csv");
		expect(out.text).toContain("Nothing was extracted or run");
		expect(out.text).toContain("attachment_to_computer");
	});

	it("orçamento total: vários arquivos grandes dividem o limite", async () => {
		const big = text("palavra ".repeat(20_000));
		const { refs, cache } = storeOf([1, 2, 3, 4].map((n) => ({ id: `f${n}`, filename: `n${n}.txt`, bytes: big })));
		const out = await buildAttachmentTurnContext(refs, { cache, nativePdf: false });
		expect(out.text.length).toBeLessThan(48_000);
		expect(out.text.match(/Showing characters/g)).toHaveLength(4);
	});

	it("nota do histórico lista só nome, tipo, tamanho e id", () => {
		const note = buildAttachmentHistoryNote([{ id: "x1", filename: "a.pdf", mime: "application/pdf", size: 2048, kind: "pdf" }]);
		expect(note).toContain('"a.pdf" (PDF, 2 KB, id x1)');
		expect(buildAttachmentHistoryNote([])).toBeNull();
	});
});

describe("ferramentas de anexo", () => {
	async function toolContext(files: Array<{ id: string; filename: string; bytes: Uint8Array }>, extra: Partial<AttachmentToolContext> = {}): Promise<AttachmentToolContext> {
		const { refs, cache } = storeOf(files);
		return { cache, list: async () => refs, ...extra };
	}

	it("attachment_read pagina o texto e busca com find", async () => {
		const ctx = await toolContext([{ id: "t1", filename: "n.txt", bytes: text(`${"a".repeat(9000)}AGULHA${"b".repeat(100)}`) }]);
		const first = await executeAttachmentTool("attachment_read", { id: "t1" }, ctx);
		expect(first.summary).toContain("characters 0-8000 of 9106");
		expect(first.summary).toContain("Next: attachment_read");
		const next = await executeAttachmentTool("attachment_read", { id: "t1", offset: 8000 }, ctx);
		expect(next.summary).toContain("AGULHA");
		const found = await executeAttachmentTool("attachment_read", { id: "t1", find: "agulha" }, ctx);
		expect(found.summary).toContain("@9000");
	});

	it("attachment_read de planilha: sheet, start_row, rows e find", async () => {
		const bytes = await makeXlsx([{ name: "Dados", rows: [["k", "v"], ...Array.from({ length: 300 }, (_, i) => [`chave${i + 1}`, i + 1])] }]);
		const ctx = await toolContext([{ id: "x1", filename: "d.xlsx", bytes }]);
		const page = await executeAttachmentTool("attachment_read", { id: "x1", sheet: "Dados", start_row: 101, rows: 3 }, ctx);
		expect(page.summary).toContain("rows 101-103 of 301");
		expect(page.summary).toContain("chave100");
		expect(page.summary).toContain("| k | v |");
		const found = await executeAttachmentTool("attachment_read", { id: "x1", find: "chave250" }, ctx);
		expect(found.summary).toContain("row 251");
		const wrong = await executeAttachmentTool("attachment_read", { id: "x1", sheet: "Nada" }, ctx);
		expect(wrong.summary).toContain('Sheet "Nada" not found');
	});

	it("attachment_list / attachment_read de zip: entradas, uma entrada de texto, binário", async () => {
		const zip = makeZip([{ name: "notas/leia.md", data: "# oi zip" }, { name: "dados.bin", data: Uint8Array.from([0, 255, 1]) }]);
		const ctx = await toolContext([{ id: "z1", filename: "p.zip", bytes: zip }]);
		const listing = await executeAttachmentTool("attachment_list", { id: "z1" }, ctx);
		expect(listing.summary).toContain("2 entries");
		expect(listing.summary).toContain("notas/leia.md");
		const entry = await executeAttachmentTool("attachment_read", { id: "z1", entry: "notas/leia.md" }, ctx);
		expect(entry.summary).toContain("# oi zip");
		const binary = await executeAttachmentTool("attachment_read", { id: "z1", entry: "dados.bin" }, ctx);
		expect(binary.summary).toContain("is binary");
		const traversal = await executeAttachmentTool("attachment_read", { id: "z1", entry: "../../etc/passwd" }, ctx);
		expect(traversal.summary).toContain("not found");
		const all = await executeAttachmentTool("attachment_list", {}, ctx);
		expect(all.summary).toContain('"p.zip"');
	});

	it("id de outra conversa/dono (fora da lista) ou inválido não lê nada", async () => {
		const ctx = await toolContext([{ id: "t1", filename: "n.txt", bytes: text("segredo") }]);
		const other = await executeAttachmentTool("attachment_read", { id: "alheio" }, ctx);
		expect(other.summary).toContain("not found in this conversation");
		await expect(executeAttachmentTool("attachment_read", { id: "../x" }, ctx)).rejects.toThrow(/id is required/);
		const none = await executeAttachmentTool("attachment_to_computer", { id: "alheio" }, { ...ctx, copyTarget: async () => ({ label: "computer", write: async () => "/x" }) });
		expect(none.summary).toContain("not found");
	});

	it("attachment_to_computer copia para anexos/<nome> sem tocar em caminho (nome sanitizado)", async () => {
		const writes: Array<{ name: string; size: number }> = [];
		const ctx = await toolContext([{ id: "b1", filename: "dados.bin", bytes: Uint8Array.from([9, 8, 7, 0]) }], {
			copyTarget: async () => ({ label: "computer", write: async (name, bytes) => { writes.push({ name, size: bytes.byteLength }); return `/home/atlas/work/anexos/${name}`; } }),
		});
		const out = await executeAttachmentTool("attachment_to_computer", { id: "b1", name: "../../etc/cron.d/evil" }, ctx);
		expect(out.summary).toContain("/home/atlas/work/anexos/evil");
		expect(out.summary).toContain("not executed");
		expect(writes).toEqual([{ name: "evil", size: 4 }]);
	});

	it("attachment_to_computer de uma entrada do zip e sem computador disponível", async () => {
		const zip = makeZip([{ name: "x/dados.csv", data: "a,b\n1,2" }]);
		const writes: string[] = [];
		const withTarget = await toolContext([{ id: "z1", filename: "p.zip", bytes: zip }], {
			copyTarget: async () => ({ label: "coding session", write: async (name) => { writes.push(name); return `/workspace/anexos/${name}`; } }),
		});
		const out = await executeAttachmentTool("attachment_to_computer", { id: "z1", entry: "x/dados.csv" }, withTarget);
		expect(out.summary).toContain("/workspace/anexos/dados.csv");
		expect(writes).toEqual(["dados.csv"]);
		const without = await toolContext([{ id: "z1", filename: "p.zip", bytes: zip }]);
		expect((await executeAttachmentTool("attachment_to_computer", { id: "z1" }, without)).summary).toContain("no computer or coding session");
	});

	it("destino da cópia: sessão de código tem prioridade, VM usa anexos/ e respeita o teto da sessão", async () => {
		const calls: string[] = [];
		const vm = { writeFile: async (_s: string, p: { path: string }) => { calls.push(`vm:${p.path}`); return { path: `/home/atlas/work/${p.path}` }; }, getSessionId: async () => "s1" };
		const dev = async (path: string) => { calls.push(`dev:${path}`); return { path }; };
		expect(attachmentCopyTarget({})).toBeNull();
		const onlyVm = attachmentCopyTarget({ vm })!;
		expect(await onlyVm.write("a.zip", new Uint8Array(3))).toBe("/home/atlas/work/anexos/a.zip");
		const both = attachmentCopyTarget({ vm, devWrite: dev })!;
		expect(await both.write("a.zip", new Uint8Array(3))).toBe("/workspace/anexos/a.zip");
		await expect(both.write("grande.bin", new Uint8Array(9 * 1024 * 1024))).rejects.toThrow(/too big/);
		expect(calls).toEqual(["vm:anexos/a.zip", "dev:/workspace/anexos/a.zip"]);
	});
});
