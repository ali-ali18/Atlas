import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TaskListCard } from "./task-list-card";

Object.assign(globalThis, { React });

const ITEMS = [
	{ content: "Ler o relatório", status: "completed" as const },
	{ content: "Montar a planilha", status: "in_progress" as const },
	{ content: "Enviar o resumo", status: "pending" as const },
];

test("em andamento: aberto, com contagem e um ícone por estado", () => {
	const html = renderToStaticMarkup(<TaskListCard items={ITEMS} />);
	assert.match(html, /data-testid="task-list-card"/);
	assert.match(html, /data-state="active"/);
	assert.match(html, /aria-expanded="true"/);
	assert.match(html, />1\/3</);
	assert.match(html, /aria-label="Concluído"/);
	assert.match(html, /aria-label="Em andamento"/);
	assert.match(html, /aria-label="Pendente"/);
	assert.match(html, /Montar a planilha/);
});

test("tudo concluído: recolhido com 'Tarefas concluídas'", () => {
	const html = renderToStaticMarkup(<TaskListCard items={ITEMS.map((item) => ({ ...item, status: "completed" as const }))} />);
	assert.match(html, /data-state="done"/);
	assert.match(html, /Tarefas concluídas/);
	assert.match(html, /aria-expanded="false"/);
	assert.doesNotMatch(html, /Enviar o resumo/);
});

test("defaultOpen força aberto mesmo concluída, e lista vazia não renderiza", () => {
	const done = ITEMS.map((item) => ({ ...item, status: "completed" as const }));
	assert.match(renderToStaticMarkup(<TaskListCard defaultOpen items={done} />), /Enviar o resumo/);
	assert.equal(renderToStaticMarkup(<TaskListCard items={[]} />), "");
});
