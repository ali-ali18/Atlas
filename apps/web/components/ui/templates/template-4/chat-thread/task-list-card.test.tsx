import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TaskListCard } from "./task-list-card";
import { ComposerDock, TaskListDock } from "./task-list-dock";

Object.assign(globalThis, { React });

const ITEMS = [
	{ content: "Ler o relatório", status: "completed" as const },
	{ content: "Montar a planilha", status: "in_progress" as const },
	{ content: "Enviar o resumo", status: "pending" as const },
];
const DONE = ITEMS.map((item) => ({ ...item, status: "completed" as const }));

test("no fio: uma linha 'Tarefas · 5/5 concluídas', recolhida, na casca padrão", () => {
	const html = renderToStaticMarkup(<TaskListCard items={DONE} />);
	assert.match(html, /data-testid="task-list-card"/);
	assert.match(html, /data-state="done"/);
	assert.match(html, /Tarefas · 3\/3 concluídas/);
	assert.match(html, /Ver tudo \(3\)/);
	assert.match(html, /aria-expanded="false"/);
	assert.doesNotMatch(html, /Enviar o resumo/);
	assert.match(html, /rounded-2xl[^"]*bg-muted\/60|bg-muted\/60[^"]*rounded-2xl/);
	assert.doesNotMatch(html, /border-border/);
});

test("no fio, run parado no meio: 'Tarefas · 1/3' sem spinner; abrir mostra um ícone por estado", () => {
	const closed = renderToStaticMarkup(<TaskListCard items={ITEMS} />);
	assert.match(closed, /data-state="stopped"/);
	assert.match(closed, /Tarefas · 1\/3</);
	assert.doesNotMatch(closed, /data-slot="spinner"/);
	const open = renderToStaticMarkup(<TaskListCard defaultOpen items={ITEMS} />);
	assert.match(open, /aria-label="Concluído"/);
	assert.match(open, /aria-label="Em andamento"/);
	assert.match(open, /aria-label="Pendente"/);
	assert.match(open, /Mostrar menos/);
	assert.equal(renderToStaticMarkup(<TaskListCard items={[]} />), "");
});

test("doca recolhida: spinner, '1/3 · tarefa atual' e botão com aria-label; lista só ao abrir", () => {
	const closed = renderToStaticMarkup(<TaskListDock items={ITEMS} />);
	assert.match(closed, /data-testid="task-list-dock"/);
	assert.match(closed, /data-testid="task-list-dock-line"[^>]*>1\/3 · Montar a planilha</);
	assert.match(closed, /aria-label="Abrir a lista de tarefas"/);
	assert.match(closed, /aria-expanded="false"/);
	assert.doesNotMatch(closed, /Enviar o resumo/);
	const open = renderToStaticMarkup(<TaskListDock defaultOpen items={ITEMS} />);
	assert.match(open, /aria-label="Recolher a lista de tarefas"/);
	assert.match(open, /Enviar o resumo/);
	assert.match(open, /max-h-\[40vh\] overflow-y-auto/);
	// seção do container único do composer: só um divisor fino, sem cartão próprio (sem fundo, raio, borda lateral nem margem)
	assert.match(closed, /border-b border-border\/60/);
	assert.doesNotMatch(closed, /bg-muted|rounded-2xl|mb-2|max-w-3xl/);
});

test("doca com tudo concluído mostra 'Tudo pronto' e lista vazia não renderiza", () => {
	assert.match(renderToStaticMarkup(<TaskListDock items={DONE} />), /3\/3 · Tudo pronto/);
	assert.equal(renderToStaticMarkup(<TaskListDock items={[]} />), "");
});

test("com aprovação pendente: a lista fica logo acima da barra de aprovação", () => {
	const html = renderToStaticMarkup(<ComposerDock approval={<div data-approval-bar />} tasks={ITEMS} />);
	assert.ok(html.indexOf("data-testid=\"task-list-dock\"") < html.indexOf("data-approval-bar"));
	const none = renderToStaticMarkup(<ComposerDock approval={<div data-approval-bar />} tasks={null} />);
	assert.doesNotMatch(none, /task-list-dock/);
});
