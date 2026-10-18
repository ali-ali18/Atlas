import assert from "node:assert/strict";
import { test } from "node:test";
import { fileCardDescription, fileCategory, fileDownloadPath, filePreviewPath } from "./file-card";

test("descrição do cartão: tipo, tamanho e versão", () => {
	assert.equal(fileCardDescription({ filename: "pvu.pdf", size: 1_258_291 }), "PDF · 1,2 MB");
	assert.equal(fileCardDescription({ filename: "a.docx", size: 340 * 1024, version: 2 }), "DOCX · 340 KB · v2");
});

test("caminhos autenticados escapam o id", () => {
	assert.equal(fileDownloadPath("abc"), "/v1/files/abc");
	assert.equal(fileDownloadPath("a/b", { inline: true }), "/v1/files/a%2Fb?inline=1");
	assert.equal(filePreviewPath("abc"), "/v1/files/abc/preview");
});

test("categoria visual por extensão", () => {
	assert.equal(fileCategory("a.pdf"), "pdf");
	assert.equal(fileCategory("a.docx"), "docx");
	assert.equal(fileCategory("a.xlsx"), "sheet");
	assert.equal(fileCategory("a.csv"), "sheet");
	assert.equal(fileCategory("a.py"), "code");
	assert.equal(fileCategory("a.txt"), "text");
});

test("zip e binário não têm prévia (baixam direto); documentos e texto têm", async () => {
	const { isPreviewableFile } = await import("./file-card");
	assert.equal(isPreviewableFile("pacote.zip", "application/zip"), false);
	assert.equal(isPreviewableFile("dados.bin", "application/octet-stream"), false);
	assert.equal(isPreviewableFile("contrato.pdf", "application/pdf"), true);
	assert.equal(isPreviewableFile("planilha.xlsx", ""), true);
	assert.equal(isPreviewableFile("notas.md", "text/markdown"), true);
});
