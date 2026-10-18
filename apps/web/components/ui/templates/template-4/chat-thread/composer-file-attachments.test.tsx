import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { FileAttachment } from "@/hooks/use-file-attachments";
import { ComposerFileAttachments } from "./composer-file-attachments";
import { FileAttachment as FileCard } from "@/components/ai-elements/files/file-attachment";

Object.assign(globalThis, { React });

function sized(name: string, bytes: number, status: FileAttachment["status"] = "done", error?: string): FileAttachment {
	return { localId: name, file: new File([new Uint8Array(bytes)], name), status, error };
}

const render = (items: FileAttachment[]) => renderToStaticMarkup(React.createElement(ComposerFileAttachments, { items, onRemove: () => {} }));
const withoutLabels = (html: string) => html.replace(/aria-label="[^"]*"/g, "");

test("sem arquivos não ocupa espaço", () => {
	assert.equal(render([]), "");
});

test("chips só com ícone (44px, linha com rolagem): sem nome visível; aria-label com nome e tamanho; remover acessível", () => {
	const html = render([sized("contrato.pdf", 1_300_000), sized("vendas.xlsx", 340_000)]);
	assert.match(html, /aria-label="Arquivos anexados"/);
	assert.equal((html.match(/data-testid="composer-file"/g) ?? []).length, 2);
	assert.ok(html.includes('aria-label="contrato.pdf, PDF · 1,2 MB"'));
	assert.ok(html.includes('aria-label="vendas.xlsx, XLSX · 332 KB"'));
	assert.doesNotMatch(withoutLabels(html), /contrato\.pdf|vendas\.xlsx|1,2 MB|332 KB/);
	assert.match(html, /size-11/);
	assert.match(html, /overflow-x-auto/);
	assert.match(html, /text-red-500/);
	assert.match(html, /text-emerald-500/);
	assert.ok(html.includes('aria-label="Remover contrato.pdf"'));
	assert.ok(html.includes('aria-label="Remover vendas.xlsx"'));
	// Remover: sempre visível no celular, só no hover no desktop.
	assert.match(html, /md:opacity-0/);
});

test("envio mostra spinner sobre o chip; erro tem borda vermelha e o motivo no rótulo", () => {
	const uploading = render([sized("a.zip", 4, "uploading")]);
	assert.ok(uploading.includes('aria-label="a.zip, Enviando…"'));
	assert.match(uploading, /animate-spin/);
	assert.match(uploading, /data-state="uploading"/);
	const failed = render([sized("b.zip", 4, "error", "Arquivo maior que 20 MB")]);
	assert.ok(failed.includes('aria-label="b.zip, Arquivo maior que 20 MB"'));
	assert.match(failed, /border-destructive/);
	assert.match(failed, /data-state="error"/);
	assert.ok(failed.includes('aria-label="Remover b.zip"'));
});

test("cartão na mensagem do usuário continua completo: à direita, tipo e tamanho; zip baixa direto, PDF abre a prévia", () => {
	const pdf = renderToStaticMarkup(React.createElement(FileCard, { artifactId: "a1", filename: "relatorio.pdf", size: 2_100_000, mime: "application/pdf", origin: "user" }));
	assert.match(pdf, /ml-auto/);
	assert.match(pdf, /data-origin="user"/);
	assert.match(pdf, /PDF · 2 MB/);
	assert.ok(pdf.includes('aria-label="Abrir prévia de relatorio.pdf"'));
	const zip = renderToStaticMarkup(React.createElement(FileCard, { artifactId: "z1", filename: "projeto.zip", size: 5_000, mime: "application/zip", origin: "user" }));
	assert.ok(zip.includes('aria-label="Baixar projeto.zip"'));
	assert.ok(zip.includes('href="/v1/files/z1"'));
	assert.doesNotMatch(zip, /Abrir prévia/);
	assert.match(zip, /text-amber-500/);
});
