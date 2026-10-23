import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parsePageSpec, type PageSpec } from "@workspace/shared";

import { PageCard, remotePageFromApi, updatedLabel } from "./page-card";
import { PageView } from "./page-view";
import { scrollEdges } from "./components/table";

Object.assign(globalThis, { React });

/** Painel v2 com a árvore dada dentro de uma `stack`. */
function page(children: unknown[], extra: Record<string, unknown> = {}): PageSpec {
	const parsed = parsePageSpec({ v: 2, title: "Forecast", root: { type: "stack", children }, ...extra });
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.spec;
}

const render = (spec: PageSpec, initialTab?: string) => renderToStaticMarkup(<PageView initialTab={initialTab} spec={spec} />);
const stat = (label: string, props: Record<string, unknown> = {}) => ({ type: "stat", props: { label, value: 1, ...props } });

test("heading e text: título e markdown formatado (sem HTML cru)", () => {
	const html = render(page([{ type: "heading", props: { text: "Resumo" } }, { type: "text", props: { markdown: "**negrito** e <script>alert(1)</script>" } }]));
	assert.match(html, /<h4[^>]*>Resumo<\/h4>/);
	assert.match(html, /<strong[^>]*>negrito<\/strong>/);
	assert.doesNotMatch(html, /<script>/);
});

test("painel v1 antigo continua renderizando (convertida para v2)", () => {
	const parsed = parsePageSpec({ v: 1, title: "Velha", blocks: [{ type: "stats", items: [{ label: "Receita", value: 10 }] }, { type: "bar_list", items: [{ label: "Sul", value: 1 }] }] });
	if (!parsed.ok) throw new Error(parsed.error);
	const html = render(parsed.spec);
	assert.match(html, /data-testid="page-stat"/);
	assert.match(html, /data-page-node="bar_list"/);
});

test("stat: grade só de stats tem 2 colunas no celular; tiles com a mesma altura; valor e variação formatados", () => {
	const html = render(page([{ type: "grid", props: { cols: 4 }, children: [
		stat("Faturamento", { value: 48320, format: "currency", delta: { value: 12, direction: "up", label: "vs. semana anterior" } }),
		stat("Pedidos", { value: 37, delta: { value: 4, kind: "absolute", direction: "up" } }),
		stat("Ticket médio", { value: 1306, unit: "BRL", delta: { value: 3, direction: "down" } }),
		stat("Em aberto", { value: 6, delta: { value: 0, direction: "flat" }, size: "lg" }),
	] }]));
	assert.match(html, /grid-cols-2 @2xl:grid-cols-4/);
	assert.equal(html.match(/data-testid="page-stat"/g)?.length, 4);
	assert.match(html, /h-full/);
	assert.match(html, /R\$\s48\.320</);
	assert.doesNotMatch(html, /48\.320,00/);
	assert.match(html, /▲ 12% vs\. semana anterior/);
	assert.match(html, /▲ 4</);
	assert.match(html, /▼ 3%/);
	assert.match(html, />—</);
	assert.doesNotMatch(html, /▬/);
	assert.match(html, /text-3xl/);
	// o rótulo da variação é truncado em uma linha, não quebra
	assert.match(html, /truncate text-\[11px\]/);
});

test("grid com outros componentes empilha no celular e usa span", () => {
	const html = render(page([{ type: "grid", props: { cols: 2 }, children: [{ type: "card", props: { title: "A" }, children: [{ type: "divider" }] }, { type: "card", props: { title: "B" }, children: [{ type: "divider" }], span: 2 }] }]));
	assert.match(html, /grid-cols-1 @md:grid-cols-2/);
	assert.match(html, /@md:col-span-2/);
});

test("bar_list: barras na cor de destaque da paleta (não preto/branco), proporcionais, com display e moeda coerente", () => {
	const html = render(page([{ type: "bar_list", props: { unit: "BRL", items: [{ label: "Sul", value: 200 }, { label: "Norte", value: 50, display: "R$ 50" }, { label: "Leste", value: 100.5 }] } }]));
	assert.match(html, /bg-\[var\(--tone\)\]/);
	assert.match(html, /--tone:var\(--chart-1\)/);
	assert.doesNotMatch(html, /bg-primary|bg-foreground/);
	assert.match(html, /width:100%/);
	assert.match(html, /width:25%/);
	assert.match(html, />R\$ 50</);
	// um valor fracionado: TODOS ganham centavos
	assert.match(html, /R\$\s200,00/);
	assert.match(html, /R\$\s100,50/);
});

test("table: rolagem horizontal, largura mínima do texto, folga na última coluna, moeda da coluna uniforme", () => {
	const html = render(page([{ type: "table", props: { variant: "striped", columns: [{ key: "c", label: "Cliente" }, { key: "v", label: "Valor", format: "currency" }], rows: [{ c: "Cooperativa Vale Verde", v: 4890 }, { c: "B", v: 3250.5 }, { c: "C", v: null }] } }]));
	assert.match(html, /overflow-x-auto/);
	assert.match(html, /min-w-max/);
	assert.match(html, /min-w-\[8.5rem\]/);
	assert.match(html, /pr-5/);
	assert.match(html, /<th[^>]*scope="col"[^>]*>Cliente<\/th>/);
	assert.match(html, /text-right[^>]*>R\$\s4\.890,00</);
	assert.match(html, /text-right[^>]*>R\$\s3\.250,50</);
	assert.match(html, />—</);
	assert.match(html, /bg-muted\/30/);
	// Degradês nas bordas (começam apagados no servidor; o cliente acende o lado com mais conteúdo ao medir).
	assert.match(html, /data-scroll-fade="start"[^>]*>/);
	assert.match(html, /data-scroll-fade="end"/);
});

test("scrollEdges: degradê só no lado que ainda tem conteúdo", () => {
	assert.deepEqual(scrollEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }), { start: false, end: false });
	assert.deepEqual(scrollEdges({ scrollLeft: 0, scrollWidth: 600, clientWidth: 300 }), { start: false, end: true });
	assert.deepEqual(scrollEdges({ scrollLeft: 150, scrollWidth: 600, clientWidth: 300 }), { start: true, end: true });
	assert.deepEqual(scrollEdges({ scrollLeft: 300, scrollWidth: 600, clientWidth: 300 }), { start: true, end: false });
});

test("chart: reserva o espaço do gráfico na largura da coluna (carregado sob demanda)", () => {
	const html = render(page([{ type: "chart", props: { spec: { type: "bar", x: "m", series: [{ key: "v" }], data: [{ m: "a", v: 1 }] } } }]));
	assert.match(html, /data-page-node="chart"/);
	assert.match(html, /chart-placeholder/);
	assert.match(html, /my-0 w-full/);
});

test("paleta do painel: escopo data-chart-palette com o CSS das cores; sem paleta, nada é injetado", () => {
	const html = render(page([stat("a")], { palette: "grove" }));
	assert.match(html, /data-chart-palette="grove"/);
	assert.match(html, /\[data-chart-palette="grove"\]\{--chart-1:/);
	assert.match(html, /@container/);
	const none = render(page([stat("a")]));
	assert.doesNotMatch(none, /data-chart-palette/);
	assert.doesNotMatch(none, /<style>/);
	const custom = render(page([stat("a")], { palette: { colors: ["#2563eb", "#f59e0b"] } }));
	assert.match(custom, /data-chart-palette="custom-/);
	assert.match(custom, /--chart-1:#/);
});

test("progress, badge e callout usam tons semânticos (nunca hex) e expõem acessibilidade", () => {
	const html = render(page([
		{ type: "progress", props: { label: "Meta de recebimento", value: 62000, max: 100000, unit: "BRL" } },
		{ type: "badge", props: { text: "Atrasado", tone: "critical" } },
		{ type: "callout", props: { title: "3 vencidos", text: "R$ 12 mil em atraso", tone: "warning" } },
	]));
	assert.match(html, /role="progressbar"[^>]*/);
	assert.match(html, /aria-valuenow="62000"/);
	assert.match(html, /62%/);
	assert.match(html, /R\$\s62\.000 de R\$\s100\.000/);
	assert.match(html, /--tone:var\(--chart-negative\)/);
	assert.match(html, /role="note"/);
	assert.match(html, /<div[^>]*data-slot="alert-title"[^>]*>3 vencidos/);
	assert.doesNotMatch(html, /#[0-9a-f]{6}/i);
});

test("timeline, kanban e list: datas, colunas com contagem, valores à direita", () => {
	const html = render(page([
		{ type: "timeline", props: { items: [{ date: "12/11", title: "Loja Exemplo", text: "R$ 4.200", tone: "warning" }, { date: "20/11", title: "Santa Rita" }] } },
		{ type: "kanban", props: { columns: [{ title: "A vencer", items: [{ title: "Loja Exemplo", subtitle: "Pedido 10482", badge: "R$ 4.200" }] }, { title: "Vencidas", items: [] }] } },
		{ type: "list", props: { unit: "BRL", items: [{ title: "Fazenda Santa Rita", subtitle: "14 pedidos", value: 14850 }, { title: "Vale Verde", value: 11200 }] } },
	]));
	assert.match(html, /<time[^>]*>12\/11<\/time>/);
	// Kanban empilha em contêiner estreito (nada cortado no celular): colunas recolhíveis com contagem, lado a lado só em @2xl.
	assert.match(html, /class="[^"]*flex-col[^"]*@2xl:flex-row[^"]*" data-page-node="kanban"/);
	assert.match(html, /<details[^>]*open=""[^>]*>\s*<summary[^>]*><h5[^>]*>A vencer<\/h5><span[^>]*>1</);
	assert.match(html, />Nada aqui</);
	assert.match(html, /R\$\s14\.850</);
	assert.match(html, /14 pedidos/);
});

test("tabs: mostra só a aba ativa (a primeira por padrão) e escolhe pela aba pedida; desconhecida cai na primeira", () => {
	const spec = page([{ type: "tabs", props: { tabs: [{ id: "visao", label: "Visão" }, { id: "detalhe", label: "Detalhe" }] }, children: [
		{ type: "tab", props: { tab: "visao" }, children: [{ type: "text", props: { markdown: "conteúdo da visão" } }] },
		{ type: "tab", props: { tab: "detalhe" }, children: [{ type: "text", props: { markdown: "conteúdo do detalhe" } }] },
	] }]);
	const first = render(spec);
	assert.match(first, /conteúdo da visão/);
	assert.doesNotMatch(first, /conteúdo do detalhe/);
	assert.match(first, /aria-selected="true"[^>]*>Visão</);
	assert.match(first, />Detalhe</);
	const second = render(spec, "detalhe");
	assert.match(second, /conteúdo do detalhe/);
	assert.doesNotMatch(second, /conteúdo da visão/);
	assert.match(render(spec, "nao-existe"), /conteúdo da visão/);
});

test("PageCard: título, N fontes, resumo, painel inteiro inline e rodapé", () => {
	const spec = page([stat("Receita", { value: 10 }), { type: "heading", props: { text: "Detalhes" } }], { summary: "Receita acima da meta" });
	const html = renderToStaticMarkup(<PageCard card={{ pageId: "p1", revision: 1, title: "Forecast Q4", action: "created", spec, sourceCount: 3 }} loadPage={async () => "missing"} />);
	assert.match(html, /aria-label="Painel: Forecast Q4"/);
	assert.match(html, /<h3[^>]*>Forecast Q4<\/h3>/);
	assert.match(html, /3 fontes/);
	assert.match(html, /Receita acima da meta/);
	assert.match(html, /data-testid="page-stat"/);
	assert.match(html, /Detalhes/);
	assert.match(html, />Painel</);
	assert.match(html, /aria-label="Abrir painel em tela cheia"/);
	// compartilhar: botão com nome acessível, fora do que vira imagem (data-share-ignore) e alvo da imagem marcado
	assert.match(html, /aria-label="Compartilhar Forecast Q4"/);
	assert.match(html, /data-share-ignore/);
	assert.match(html, /data-share-target/);
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

test("remotePageFromApi: a data mostrada é a da última atualização com dados novos (refreshedAt), senão a da edição", () => {
	const base = { spec: page([{ type: "divider" }]), revision: 4, sources: [], updatedAt: "2026-10-22T10:00:00Z" };
	assert.equal(remotePageFromApi({ ...base, refreshedAt: "2026-10-22T11:55:00Z" }).updatedAt, "2026-10-22T11:55:00Z");
	assert.equal(remotePageFromApi({ ...base, refreshedAt: null }).updatedAt, "2026-10-22T10:00:00Z");
	assert.equal(remotePageFromApi({ ...base, refreshedAt: null }).revision, 4);
});
