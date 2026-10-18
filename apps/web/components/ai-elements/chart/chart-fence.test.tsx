import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { markdownComponents } from "@/components/ui/templates/template-4/chat-thread/assistant-message";
import { MarkdownStreamingContext } from "@/components/ai-elements/files/markdown-code-block";
import { resolveChartFence } from "./chart-fence";

Object.assign(globalThis, { React });

const SPEC = { type: "line", title: "Vendas", x: "mes", series: [{ key: "total" }], data: [{ mes: "2025-01-01", total: 10 }, { mes: "2025-02-01", total: 12 }] };
const FENCE = "```chart\n" + JSON.stringify(SPEC) + "\n```\n";

const render = (md: string, streaming = false) =>
	renderToStaticMarkup(
		<MarkdownStreamingContext.Provider value={streaming}>
			<ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
				{md}
			</ReactMarkdown>
		</MarkdownStreamingContext.Provider>,
	);

test("resolveChartFence: spec válido vira gráfico", () => {
	const fence = resolveChartFence(JSON.stringify(SPEC), false);
	assert.equal(fence.kind, "chart");
});

test("resolveChartFence: JSON incompleto no streaming é pendente; fechado e inválido é inválido", () => {
	const partial = JSON.stringify(SPEC).slice(0, 50);
	assert.deepEqual(resolveChartFence(partial, true), { kind: "pending" });
	assert.deepEqual(resolveChartFence("", true), { kind: "pending" });
	assert.equal(resolveChartFence(partial, false).kind, "invalid");
	assert.equal(resolveChartFence('{"type":"radar"}', false).kind, "invalid");
});

test("bloco chart válido não aparece como código (vira o gráfico carregando)", () => {
	const html = render(FENCE);
	assert.doesNotMatch(html, /data-slot="code-block"/);
	assert.match(html, /Carregando gráfico/);
});

test("bloco chart incompleto durante o streaming mostra 'Gerando gráfico…'", () => {
	const html = render("Veja:\n\n```chart\n" + JSON.stringify(SPEC).slice(0, 60), true);
	assert.match(html, /Gerando gráfico/);
	assert.doesNotMatch(html, /data-slot="code-block"/);
});

test("bloco chart inválido ao terminar mostra o código com aviso discreto", () => {
	const html = render("```chart\n{\"type\": \"line\", \n```\n", false);
	assert.match(html, /data-slot="code-block"/);
	assert.match(html, /JSON está incompleto ou inválido/);
	assert.doesNotMatch(html, /Gerando gráfico/);
});

test("outras linguagens seguem como código normal", () => {
	const html = render("```json\n{\"a\":1}\n```\n");
	assert.match(html, /data-slot="code-block"/);
	assert.doesNotMatch(html, /Gerando gráfico|Carregando gráfico/);
});
