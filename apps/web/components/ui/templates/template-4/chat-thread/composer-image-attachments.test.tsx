import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { ImageAttachment } from "@/hooks/use-image-attachments";
import { ComposerImageAttachments } from "./composer-image-attachments";

// O runner Node usa JSX clássico nos primitivos com jsx: preserve do Next.
Object.assign(globalThis, { React });

function image(status: ImageAttachment["status"], index = 0): ImageAttachment {
	return {
		localId: `image-${index}`,
		file: new File(["image"], `foto-${index}.png`, { type: "image/png" }),
		previewUrl: `blob:preview-${index}`,
		status,
		error: status === "error" ? "Upload falhou" : undefined,
	};
}

function render(items: ImageAttachment[]) {
	return renderToStaticMarkup(React.createElement(ComposerImageAttachments, { items, onRemove: () => {} }));
}

test("não acrescenta uma faixa vazia quando não há imagens", () => {
	assert.equal(render([]), "");
});

test("renderiza até quatro imagens no addon acima do texto com remoção identificada", () => {
	const html = render(Array.from({ length: 4 }, (_, index) => image("done", index)));
	assert.match(html, /data-align="block-start"/);
	assert.equal((html.match(/<img /g) ?? []).length, 4);
	assert.equal((html.match(/<button /g) ?? []).length, 4);
	for (let index = 0; index < 4; index++) {
		assert.ok(html.includes(`aria-label="Remover foto-${index}.png"`));
	}
	assert.match(html, /type="button"/);
});

test("mantém o botão de remoção nos estados de upload e erro", () => {
	const html = render([image("uploading"), image("error", 1)]);
	assert.match(html, /aria-label="Enviando imagem"/);
	assert.match(html, /title="Upload falhou"/);
	assert.equal((html.match(/<button /g) ?? []).length, 2);
	assert.match(html, /aria-label="Remover foto-0.png"/);
	assert.match(html, /aria-label="Remover foto-1.png"/);
});
