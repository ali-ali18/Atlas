import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AtlasPageListItem } from "@/lib/atlas-api";
import type { Routine } from "../data";
import { PAGES_EMPTY_TEXT, PagesList, routineSummaryByPage } from "./pages-library";

Object.assign(globalThis, { React });

const now = new Date("2026-10-26T12:00:00.000Z");
const page = (over: Partial<AtlasPageListItem> = {}): AtlasPageListItem => ({
	id: "p1",
	botId: "b1",
	title: "Vendas da semana",
	revision: 3,
	sourceCount: 2,
	updatedAt: "2026-10-26T10:00:00.000Z",
	refreshedAt: null,
	...over,
});

const weekly: Routine = {
	id: "r1",
	name: "Atualiza painel",
	instruction: "refaz",
	model: "m",
	active: true,
	triggerKind: "interval",
	triggers: [{ id: "interval", text: "A cada 50 min" }],
	pageId: "p1",
};

test("sem painéis: estado vazio em pt-BR convida a pedir um painel ou relatório ao bot", () => {
	const html = renderToStaticMarkup(<PagesList items={[]} />);
	assert.ok(html.includes(PAGES_EMPTY_TEXT));
	assert.match(PAGES_EMPTY_TEXT, /Peça ao bot um painel ou relatório/);
	assert.doesNotMatch(html, /data-page-card/);
});

test("cartão do painel: título, 'N fontes', 'Atualizado há X', abrir e apagar acessíveis", () => {
	const html = renderToStaticMarkup(<PagesList items={[page(), page({ id: "p2", title: "Estoque", sourceCount: 1, updatedAt: "2026-10-25T09:00:00.000Z" })]} now={now} />);
	assert.match(html, /data-page-card="p1"/);
	assert.match(html, />Vendas da semana</);
	assert.match(html, /2 fontes · Atualizado há 2 h/);
	assert.match(html, /1 fonte · Atualizado ontem/);
	assert.match(html, /aria-label="Abrir painel Vendas da semana"/);
	assert.match(html, /aria-label="Apagar painel Vendas da semana"/);
	assert.doesNotMatch(html, /Atualizado por rotina/);
});

test("painel com rotina mostra o ícone e o resumo do agendamento; refreshedAt vence updatedAt", () => {
	const html = renderToStaticMarkup(
		<PagesList items={[page({ refreshedAt: "2026-10-26T11:58:00.000Z" })]} now={now} routineByPage={routineSummaryByPage([weekly])} />,
	);
	assert.match(html, /aria-label="Atualizado por rotina: A cada 50 min"/);
	assert.match(html, /Atualizado há 2 min/);
	assert.match(html, />A cada 50 min</);
});

test("routineSummaryByPage: só rotinas ligadas o painel; pausada avisa; a primeira vence", () => {
	const byPage = routineSummaryByPage([
		{ ...weekly, id: "r0", pageId: undefined },
		weekly,
		{ ...weekly, id: "r2", active: false, triggers: [{ id: "interval", text: "A cada 2 h" }] },
		{ ...weekly, id: "r3", pageId: "p9", active: false },
	]);
	assert.equal(byPage.get("p1"), "A cada 50 min");
	assert.equal(byPage.get("p9"), "A cada 50 min (pausada)");
	assert.equal(byPage.size, 2);
});

test("lixeira some até o hover/foco no mouse e até a pressão longa no toque", () => {
	const hidden = renderToStaticMarkup(<PagesList items={[page()]} now={now} />);
	assert.match(hidden, /group\/row/);
	assert.match(hidden, /\[@media\(hover:hover\)\]:opacity-0/);
	assert.match(hidden, /\[@media\(hover:hover\)\]:group-hover\/row:opacity-100/);
	assert.match(hidden, /\[@media\(hover:hover\)\]:group-focus-within\/row:opacity-100/);
	assert.match(hidden, /\[@media\(hover:none\)\]:hidden/);
	assert.match(hidden, /aria-label="Apagar painel Vendas da semana"/);

	const shown = renderToStaticMarkup(<PagesList items={[page(), page({ id: "p2", title: "Estoque" })]} now={now} revealedId="p1" />);
	const [first = "", second = ""] = shown.split('data-page-card="p2"');
	assert.doesNotMatch(first.slice(first.indexOf("Apagar painel Vendas")), /hover:none\)\]:hidden/);
	assert.match(second, /\[@media\(hover:none\)\]:hidden/);
});

test("painéis agrupados: bloco do grupo com 'N painéis' e, depois, os sem grupo", () => {
	const html = renderToStaticMarkup(
		<PagesList
			groups={[{ id: "g1", name: "Vendas Loja Exemplo" }, { id: "g2", name: "Financeiro" }]}
			items={[
				page({ id: "p1", title: "Funil", groupId: "g1", explicitGroupId: "g1" }),
				page({ id: "p2", title: "Solto" }),
				page({ id: "p3", title: "Meta", groupId: "g1", explicitGroupId: null }),
			]}
			now={now}
			onMove={() => undefined}
		/>,
	);
	assert.match(html, /data-page-group="g1"/);
	assert.doesNotMatch(html, /data-page-group="g2"/);
	assert.match(html, />Vendas Loja Exemplo</);
	assert.match(html, />2 painéis</);
	assert.match(html, /aria-label="Recolher grupo Vendas Loja Exemplo"/);
	assert.ok(html.indexOf('data-page-card="p2"') > html.indexOf('data-page-card="p3"'));
	assert.match(html, /aria-label="Mais ações do painel Funil"/);
});

test("sem a lista de grupos, as seções saem do nome que a listagem traz; sem onMove não há menu", () => {
	const html = renderToStaticMarkup(<PagesList items={[page({ groupId: "g9", groupName: "Clima" })]} now={now} />);
	assert.match(html, /data-page-group="g9"/);
	assert.match(html, />1 painel</);
	assert.doesNotMatch(html, /Mais ações do painel/);
});
