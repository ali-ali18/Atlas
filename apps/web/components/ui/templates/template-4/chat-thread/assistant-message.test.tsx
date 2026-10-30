import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "./assistant-message";

Object.assign(globalThis, { React });

const md = "- **Commit:** `fd59716` em `next.config.ts`\n- https://github.com/acme/painel-app/commit/fd597168e1b979701c7636040a62350e\n\n```\nconst muitoLongo = 1\n```\n";

test("links, código inline e itens quebram em qualquer ponto; bloco de código rola", () => {
	const html = renderToStaticMarkup(
		<ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
			{md}
		</ReactMarkdown>,
	);
	assert.match(html, /<li class="[^"]*min-w-0[^"]*overflow-wrap:anywhere/);
	assert.match(html, /<a class="[^"]*overflow-wrap:anywhere/);
	assert.match(html, /<code class="[^"]*overflow-wrap:anywhere[^"]*">fd59716/);
	assert.match(html, /<pre[^>]*overflow-auto/);
});

test("a bolha nunca passa da largura máxima (68ch limitado a 100%)", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("./assistant-message.tsx", import.meta.url), "utf8");
	assert.match(source, /max-w-\[min\(68ch,100%\)\]/);
	assert.doesNotMatch(source, /"max-w-\[68ch\]/);
});

test("tabela larga rola na horizontal dentro do container; valores não quebram e nomes têm largura mínima", async () => {
	const { cellWidthClass } = await import("./assistant-message");
	const table = "| Cliente | Vencimento | Valor |\n| --- | --- | ---: |\n| Distribuidora Santa Helena de Alimentos Ltda | 14/09/2026 | R$ 12.480,90 |\n";
	const html = renderToStaticMarkup(
		<ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
			{table}
		</ReactMarkdown>,
	);
	assert.match(html, /<div class="[^"]*overflow-x-auto[^"]*" data-slot="markdown-table"><table class="[^"]*w-max[^"]*min-w-full/);
	assert.match(html, /<td class="[^"]*min-w-\[8rem\][^"]*">Distribuidora/);
	assert.match(html, /<td class="[^"]*whitespace-nowrap[^"]*">14\/09\/2026/);
	assert.match(html, /<td class="[^"]*whitespace-nowrap[^"]*"[^>]*>R\$ 12\.480,90/);
	assert.equal(cellWidthClass("Mercado Bom Preço"), "min-w-[8rem] max-w-[22rem]");
	assert.equal(cellWidthClass("45%"), "whitespace-nowrap");
});
