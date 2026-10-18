import assert from "node:assert/strict";
import test from "node:test";
import { validateImageFiles } from "./use-image-attachments";

const file = (type: string, size = 1) => new File([new Uint8Array(size)], "foto", { type });

test("aceita até quatro imagens nos formatos suportados", () => {
	assert.equal(validateImageFiles([file("image/png"), file("image/jpeg")], 2), null);
	assert.match(validateImageFiles([file("image/webp")], 4) ?? "", /Até 4/);
});

test("recusa SVG e imagem acima de 10 MB", () => {
	assert.match(validateImageFiles([file("image/svg+xml")], 0) ?? "", /PNG/);
	assert.match(validateImageFiles([file("image/gif", 10 * 1024 * 1024 + 1)], 0) ?? "", /10 MB/);
});
