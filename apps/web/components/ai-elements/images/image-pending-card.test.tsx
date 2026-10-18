import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ImagePendingCard } from "./image-pending-card";

Object.assign(globalThis, { React });

test("rodando: proporção pedida, texto e tempo", () => {
	const html = renderToStaticMarkup(<ImagePendingCard aspectRatio="16:9" count={2} startedAt={Date.now()} status="running" />);
	assert.equal((html.match(/data-testid="image-pending-frame"/g) ?? []).length, 2);
	assert.match(html, /aspect-ratio:16 \/ 9/);
	assert.match(html, /Gerando imagens…/);
	assert.match(html, /0 s/);
	assert.match(html, /data-slot="skeleton"/);
});

test("1:1 padrão com uma imagem", () => {
	const html = renderToStaticMarkup(<ImagePendingCard aspectRatio="1:1" count={1} startedAt={Date.now()} status="running" />);
	assert.equal((html.match(/data-testid="image-pending-frame"/g) ?? []).length, 1);
	assert.match(html, /Gerando imagem…/);
});

test("erro: mensagem no mesmo cartão, sem shimmer", () => {
	const html = renderToStaticMarkup(<ImagePendingCard aspectRatio="4:3" count={1} error="Sem créditos" startedAt={Date.now()} status="error" />);
	assert.match(html, /Sem créditos/);
	assert.match(html, /role="alert"/);
	assert.doesNotMatch(html, /data-slot="skeleton"/);
});
