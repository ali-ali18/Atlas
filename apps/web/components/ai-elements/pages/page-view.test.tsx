import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parsePageSpec, type PageSpec } from "@workspace/shared";

import { PageCard, updatedLabel } from "./page-card";
import { PageView } from "./page-view";

Object.assign(globalThis, { React });

function page(blocks: unknown[], extra: Record<string, unknown> = {}): PageSpec {
	const parsed = parsePageSpec({ title: "Forecast", blocks, ...extra });
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.spec;
}

const render = (spec: PageSpec, initialTab?: string) => renderToStaticMarkup(<PageView initialTab={initialTab} spec={spec} />);

test("heading e markdown: título e texto formatado (sem HTML cru)", () => {
	const html = render(page([{ type: "heading", text: "Resumo" }, { type: "markdown", text: "**negrito** e <script>alert(1)</script>" }]));
	assert.match(html, /<h3[^>]*>Resumo<\/h3>/);
	assert.match(html, /<strong[^>]*>negrito<\/strong>/);
	assert.doesNotMatch(html, /<script>/);
});

test("stats: tiles em grade de 2 colunas no celular, com valor formatado e variação", () => {
	const html = render(page([{ type: "stats", items: [{ label: "Receita", value: 120000, unit: "BRL", delta: { value: 8, direction: "up", label: "vs meta" } }, { label: "Churn", value: "baixo" }] }]));
	assert.match(html, /grid-cols-2/);
	assert.equal(html.match(/data-testid="page-stat"/g)?.length, 2);
	assert.match(html, /R\$\s120\.000,00/);
	assert.match(html, /▲ 8% vs meta/);
	assert.match(html, />baixo</);
});

test("bar_list: uma barra por item, proporcional ao maior, com display e unidade", () => {
	const html = render(page([{ type: "bar_list", unit: "BRL", items: [{ label: "Sul", value: 200 }, { label: "Norte", value: 50, display: "50 mil" }] }]));
	assert.match(html, /Sul/);
	assert.match(html, /width:100%/);
	assert.match(html, /width:25%/);
	assert.match(html, />50 mil</);
	assert.match(html, /R\$\s200,00/);
});

test("table: rolagem horizontal, cabeçalho com escopo, números à direita e célula vazia como traço", () => {
	const html = render(page([{ type: "table", columns: [{ key: "n", label: "Nome" }, { key: "v", label: "Valor", format: "compact" }], rows: [{ n: "A", v: 1500 }, { n: "B", v: null }] }]));
	assert.match(html, /overflow-x-auto/);
	assert.match(html, /<th[^>]*scope="col"[^>]*>Nome<\/th>/);
	assert.match(html, /text-right[^>]*>1,5\smil</);
	assert.match(html, />—</);
});

test("chart: reserva o espaço do gráfico (carregado sob demanda)", () => {
	const html = render(page([{ type: "chart", spec: { type: "bar", x: "m", series: [{ key: "v" }], data: [{ m: "a", v: 1 }] } }]));
	assert.match(html, /data-page-block="chart"/);
	assert.match(html, /chart-placeholder/);
});

test("tabs: mostra só a aba ativa (a primeira por padrão) e troca ao escolher outra", () => {
	const spec = page([{ type: "tabs", tabs: [{ label: "Visão", blocks: [{ type: "markdown", text: "conteúdo da visão" }] }, { label: "Detalhe", blocks: [{ type: "markdown", text: "conteúdo do detalhe" }] }] }]);
	const first = render(spec);
	assert.match(first, /conteúdo da visão/);
	assert.doesNotMatch(first, /conteúdo do detalhe/);
	assert.match(first, />Visão</);
	assert.match(first, />Detalhe</);
	assert.match(first, /aria-selected="true"[^>]*>Visão</);
	const second = render(spec, "detalhe");
	assert.match(second, /conteúdo do detalhe/);
	assert.doesNotMatch(second, /conteúdo da visão/);
	// Aba desconhecida cai na primeira.
	assert.match(render(spec, "nao-existe"), /conteúdo da visão/);
});

test("PageCard: título, N fontes, resumo, página inteira inline e rodapé", () => {
	const spec = page([{ type: "stats", items: [{ label: "Receita", value: 10 }] }, { type: "heading", text: "Detalhes" }], { summary: "Receita acima da meta" });
	const html = renderToStaticMarkup(<PageCard card={{ pageId: "p1", revision: 1, title: "Forecast Q4", action: "created", spec, sourceCount: 3 }} loadPage={async () => "missing"} />);
	assert.match(html, /aria-label="Página: Forecast Q4"/);
	assert.match(html, /<h3[^>]*>Forecast Q4<\/h3>/);
	assert.match(html, /3 fontes/);
	assert.match(html, /Receita acima da meta/);
	assert.match(html, /data-testid="page-stat"/);
	assert.match(html, /Detalhes/);
	assert.match(html, />Página</);
	assert.match(html, /aria-label="Abrir página em tela cheia"/);
});

test("PageCard sem snapshot mostra o esqueleto até o servidor responder, e 1 fonte no singular", () => {
	const html = renderToStaticMarkup(<PageCard card={{ pageId: "p1", revision: 1, title: "Antiga", action: "created", sourceCount: 1 }} loadPage={async () => "missing"} />);
	assert.match(html, /page-loading/);
	assert.match(html, /1 fonte</);
});

test("updatedLabel: relativo, vazio sem data", () => {
	const now = new Date("2026-10-22T12:00:00Z");
	assert.equal(updatedLabel("2026-10-22T11:55:00Z", now), "Atualizado há 5 min");
	assert.equal(updatedLabel("2026-10-22T11:59:50Z", now), "Atualizado agora");
	assert.equal(updatedLabel(null, now), null);
});
