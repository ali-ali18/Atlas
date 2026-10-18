import assert from "node:assert/strict";
import test from "node:test";
import { isImageFile, MAX_FILE_ATTACHMENTS, MAX_FILE_BYTES, validateAttachmentFiles } from "./use-file-attachments";

const file = (name: string, size: number, type = "") => {
	const value = new File([new Uint8Array(Math.min(size, 8))], name, { type });
	Object.defineProperty(value, "size", { value: size });
	return value;
};

test("limites: 5 arquivos por mensagem e 20 MB por arquivo", () => {
	assert.equal(MAX_FILE_ATTACHMENTS, 5);
	assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
	assert.equal(validateAttachmentFiles([file("a.pdf", 10)], 0), null);
	assert.equal(validateAttachmentFiles([file("a.pdf", MAX_FILE_BYTES)], 0), null);
	assert.match(validateAttachmentFiles([file("a.pdf", MAX_FILE_BYTES + 1)], 0) ?? "", /20 MB/);
	assert.match(validateAttachmentFiles([file("a.pdf", 10), file("b.pdf", 10)], 4) ?? "", /Até 5 arquivos/);
	assert.equal(validateAttachmentFiles(Array.from({ length: 5 }, (_, i) => file(`f${i}.txt`, 1)), 0), null);
	assert.match(validateAttachmentFiles([file("vazio.txt", 0)], 0) ?? "", /vazio/);
});

test("imagens seguem pelo anexo de imagem; o resto vai como arquivo", () => {
	assert.equal(isImageFile(file("a.png", 1, "image/png")), true);
	assert.equal(isImageFile(file("a.pdf", 1, "application/pdf")), false);
	assert.equal(isImageFile(file("sem-tipo.bin", 1, "")), false);
});
