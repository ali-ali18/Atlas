import assert from "node:assert/strict";
import test from "node:test";
import { buildPdfFromJpeg, shareDateLabel, shareFileName, shareFooterText } from "./share-image";

const now = new Date(2026, 9, 3, 10, 0, 0);

test("rodapé: nome do bot e data em pt-BR; sem nome, só a data", () => {
	assert.equal(shareDateLabel(now), "03/10/2026");
	assert.equal(shareFooterText("Atlas Vendas", now), "Atlas Vendas · 03/10/2026");
	assert.equal(shareFooterText("  ", now), "03/10/2026");
	assert.equal(shareFooterText(null, now), "03/10/2026");
});

test("nome do arquivo: sem acento nem símbolos, com data e extensão; vazio vira atlas", () => {
	assert.equal(shareFileName("Vendas · Loja Exemplo (Q4)!", "png", now), "vendas-loja-exemplo-q4-2026-10-03.png");
	assert.equal(shareFileName("Relatório de conversão", "pdf", now), "relatorio-de-conversao-2026-10-03.pdf");
	assert.equal(shareFileName("???", "png", now), "atlas-2026-10-03.png");
	assert.equal(shareFileName(undefined, "png", now), "atlas-2026-10-03.png");
	assert.ok(shareFileName("a".repeat(200), "png", now).length <= 60 + "-2026-10-03.png".length);
	assert.doesNotMatch(shareFileName("../../etc/passwd", "png", now), /[/\\]/);
});

test("PDF: cabeçalho, uma página do tamanho da imagem, JPEG embutido e xref com os offsets certos", () => {
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
	const pdf = buildPdfFromJpeg(jpeg, 800, 400);
	const text = new TextDecoder("latin1").decode(pdf);
	assert.ok(text.startsWith("%PDF-1.4\n"));
	assert.ok(text.endsWith("%%EOF\n"));
	assert.match(text, /\/MediaBox \[0 0 600 300\]/);
	assert.match(text, /\/Width 800 \/Height 400/);
	assert.match(text, new RegExp(`/Length ${jpeg.length} >>`));
	assert.ok(text.includes("/Filter /DCTDecode"));
	// os offsets do xref apontam para "N 0 obj"
	const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
	assert.equal(text.slice(xrefAt, xrefAt + 4), "xref");
	const entries = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n /g)].map((match) => Number(match[1]));
	assert.equal(entries.length, 5);
	entries.forEach((offset, index) => assert.equal(text.slice(offset, offset + 8), `${index + 1} 0 obj\n`.slice(0, 8)));
});
