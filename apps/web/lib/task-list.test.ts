import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message } from "@/components/ui/templates/template-4/data";
import { dedupeCards, reconcilePersistedThread } from "./thread-merge";
import { dockedTaskList, taskListDockLine, taskListProgress, taskListSettledLabel } from "./task-list";

const ITEMS = [
	{ content: "Ler o relatório", status: "completed" as const },
	{ content: "Montar a planilha", status: "in_progress" as const },
	{ content: "Enviar o resumo", status: "pending" as const },
];
const user = (id: string): Message => ({ id, kind: "user", text: "faça" }) as Message;
const list = (id: string, runId = "run-1", items = ITEMS): Message => ({ id, kind: "task-list", runId, items });

test("progresso: feitas, total e a tarefa atual (em andamento, senão a próxima pendente)", () => {
	assert.deepEqual({ ...taskListProgress(ITEMS), current: undefined }, { total: 3, done: 1, allDone: false, current: undefined });
	assert.equal(taskListProgress(ITEMS).current?.content, "Montar a planilha");
	assert.equal(taskListProgress([ITEMS[0]!, ITEMS[2]!]).current?.content, "Enviar o resumo");
});

test("linha da doca e resumo no fio", () => {
	assert.equal(taskListDockLine(ITEMS), "1/3 · Montar a planilha");
	const done = ITEMS.map((item) => ({ ...item, status: "completed" as const }));
	assert.equal(taskListDockLine(done), "3/3 · Tudo pronto");
	assert.equal(taskListSettledLabel(done), "Tarefas · 3/3 concluídas");
	assert.equal(taskListSettledLabel(ITEMS), "Tarefas · 1/3");
});

test("run ativo: a lista do turno atual vai para a doca; sem run ativo ela fica no fio", () => {
	const thread = [user("u1"), list("tl-old", "run-0"), user("u2"), list("tl", "run-1")];
	assert.equal(dockedTaskList(thread, true)?.id, "tl");
	assert.equal(dockedTaskList(thread, false), null);
});

test("lista de um turno anterior não vira doca no run novo; lista vazia também não", () => {
	assert.equal(dockedTaskList([user("u1"), list("tl-old", "run-0"), user("u2")], true), null);
	assert.equal(dockedTaskList([user("u1"), list("tl", "run-1", [])], true), null);
});

test("um run, uma lista: ao vivo e gravada colapsam em um cartão só", () => {
	const merged = reconcilePersistedThread([user("db-u1"), list("db-tl")], [user("db-u1"), list("task-list-run-1")]);
	assert.equal(merged.filter((message) => message.kind === "task-list").length, 1);
	assert.equal(dedupeCards([list("a"), list("b")]).length, 1);
});

test("pessoa manda outra fala no meio do run: com o run ativo a doca continua mostrando a lista dele", () => {
	const thread = [user("u1"), list("tl", "run-1"), user("u2")];
	assert.equal(dockedTaskList(thread, true, "run-1")?.id, "tl");
	// Sem o id do run (compat), vale a regra antiga: só depois da última fala.
	assert.equal(dockedTaskList(thread, true), null);
});

test("doca amarrada ao run: lista de outro run não aparece; cartão ainda sem run (local) só no turno atual", () => {
	assert.equal(dockedTaskList([user("u1"), list("tl-old", "run-0"), user("u2")], true, "run-1"), null);
	assert.equal(dockedTaskList([user("u1"), list("tl", "local")], true, "run-1")?.id, "tl");
	assert.equal(dockedTaskList([user("u1"), list("tl", "local"), user("u2")], true, "run-1"), null);
});

test("run terminado: nada na doca, o cartão final fica no fio com tudo concluído", () => {
	const done = ITEMS.map((item) => ({ ...item, status: "completed" as const }));
	const thread = [user("u1"), list("tl", "run-1", done), user("u2")];
	assert.equal(dockedTaskList(thread, false, "run-1"), null);
	assert.equal(thread.some((message) => message.kind === "task-list" && taskListSettledLabel(message.items) === "Tarefas · 3/3 concluídas"), true);
});
