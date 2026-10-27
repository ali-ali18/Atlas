/** `/compact` no banco: o que bloqueia, a regravação otimista da conversa levada e a marca d'água nova. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { findCompactionBlocker, writeCompactedTranscript } from "./conversation-compaction.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let runs: InstanceType<typeof FakeTable>;
let messages: InstanceType<typeof FakeTable>;
let conversations: InstanceType<typeof FakeTable>;
let installed: { restore: () => void };

const T0 = new Date("2026-01-01T10:00:00Z");
const checkpoint = {
	version: 1,
	llmMessages: [{ role: "system", content: "prompt" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }],
	loadedTools: ["mcp__erp__list_items"],
	carriedNotes: [{ key: "k", content: "nota", idleTurns: 0 }],
	taskState: { taskList: [{ content: "passo", status: "in_progress" }] },
	transcriptWatermark: { messageId: "m-old", createdAt: "2026-01-01T09:00:00.000Z", count: 2 },
};

beforeEach(() => {
	runs = new FakeTable([
		{ id: "run-1", userId: "user-a", conversationId: "conv-1", origin: "chat", parentRunId: null, status: "completed", checkpointJson: checkpoint, createdAt: T0, updatedAt: T0, finishedAt: T0 },
	]);
	messages = new FakeTable([
		{ id: "m-1", conversationId: "conv-1", role: "user", content: "a", createdAt: new Date("2026-01-01T09:00:00Z") },
		{ id: "m-2", conversationId: "conv-1", role: "assistant", content: "b", createdAt: new Date("2026-01-01T09:30:00Z") },
	]);
	// O fake só ordena por uma chave; a marca d'água usa [createdAt, id] desc: aqui a última linha por data.
	messages.findFirst = async () => [...messages.rows].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())[0] ?? null;
	conversations = new FakeTable([{ id: "conv-1", userId: "user-a", untrustedAt: new Date("2026-01-01T09:45:00Z") }]);
	installed = installFakes({ agentRun: runs, conversationMessage: messages, conversation: conversations });
});
afterEach(() => installed.restore());

const write = (overrides: Record<string, unknown> = {}) =>
	writeCompactedTranscript({
		userId: "user-a",
		conversationId: "conv-1",
		transcript: { runId: "run-1", updatedAt: T0 },
		llmMessages: [{ role: "system", content: "prompt" }, { role: "system", content: "[Conversation summary] resumo" }, { role: "user", content: "a" }],
		compaction: { before: 48_200, after: 6_100 },
		now: new Date("2026-01-01T11:00:00Z"),
		...overrides,
	} as Parameters<typeof writeCompactedTranscript>[0]);

test("grava a conversa compactada, avança a marca d'água e preserva tools, notas levadas e lista de tarefas", async () => {
	assert.equal(await write(), true);
	const saved = runs.rows[0]!.checkpointJson as Record<string, unknown>;
	assert.equal((saved.llmMessages as Array<{ content: string }>)[1]!.content, "[Conversation summary] resumo");
	assert.deepEqual(saved.transcriptWatermark, { messageId: "m-2", createdAt: "2026-01-01T09:30:00.000Z", count: 2 });
	assert.deepEqual(saved.compaction, { before: 48_200, after: 6_100, at: "2026-01-01T11:00:00.000Z" });
	assert.deepEqual(saved.loadedTools, checkpoint.loadedTools);
	assert.deepEqual(saved.carriedNotes, checkpoint.carriedNotes);
	assert.deepEqual(saved.taskState, checkpoint.taskState);
});

test("compactar tira a marca de conteúdo externo da conversa (e o aviso do checkpoint); falhar na gravação mantém", async () => {
	runs.rows[0]!.checkpointJson = { ...checkpoint, untrustedSeen: true };
	assert.equal(await write({ userId: "user-b" }), false);
	assert.ok(conversations.rows[0]!.untrustedAt instanceof Date, "outro dono não limpa");
	assert.equal(await write({ transcript: { runId: "run-1", updatedAt: new Date("2026-01-01T09:59:00Z") } }), false);
	assert.ok(conversations.rows[0]!.untrustedAt instanceof Date, "gravação perdida não limpa");
	assert.equal(await write(), true);
	assert.equal(conversations.rows[0]!.untrustedAt, null);
	assert.equal((runs.rows[0]!.checkpointJson as Record<string, unknown>).untrustedSeen, undefined);
});

test("gravação otimista: se o run mudou desde a leitura (ou a leitura é de outra versão), nada é gravado", async () => {
	runs.rows[0]!.updatedAt = new Date("2026-01-01T10:00:05Z");
	assert.equal(await write(), false);
	assert.deepEqual(runs.rows[0]!.checkpointJson, checkpoint);
	runs.rows[0]!.updatedAt = T0;
	assert.equal(await write({ transcript: { runId: "run-1", updatedAt: undefined } }), false);
	assert.equal(await write({ transcript: { runId: "run-1", updatedAt: new Date("2026-01-01T09:59:00Z") } }), false);
});

test("duas compactações com a mesma leitura: só a primeira grava", async () => {
	assert.equal(await write(), true);
	assert.equal(await write(), false);
});

test("só o dono grava; outro usuário ou conversa não toca no checkpoint", async () => {
	assert.equal(await write({ userId: "user-b" }), false);
	assert.equal(await write({ userId: "default" }), false);
	assert.equal(await write({ conversationId: "conv-2" }), false);
	assert.deepEqual(runs.rows[0]!.checkpointJson, checkpoint);
});

test("bloqueio: execução em andamento e a que espera a pessoa", async () => {
	assert.equal(await findCompactionBlocker("conv-1"), null);
	runs.rows[0]!.status = "running";
	assert.equal(await findCompactionBlocker("conv-1"), "run_active");
	runs.rows[0]!.status = "waiting_user";
	assert.equal(await findCompactionBlocker("conv-1"), "approval_pending");
	assert.equal(await findCompactionBlocker("conv-2"), null);
});

test("bloqueio: aprovação pendente só vale se for do run recente; decidida ou antiga não bloqueia", async () => {
	const confirm = (id: string, status: string, createdAt: Date) => ({
		id,
		conversationId: "conv-1",
		role: "confirm",
		createdAt,
		content: JSON.stringify({ v: 1, kind: "confirm", title: "Criar pedido", status, confirmId: id }),
	});
	messages.rows.push(confirm("c-old", "pending", new Date("2025-12-01T10:00:00Z")));
	assert.equal(await findCompactionBlocker("conv-1", T0), null);
	messages.rows.push(confirm("c-done", "approved", new Date("2026-01-01T10:01:00Z")));
	assert.equal(await findCompactionBlocker("conv-1", T0), null);
	messages.rows.push(confirm("c-new", "pending", new Date("2026-01-01T10:02:00Z")));
	assert.equal(await findCompactionBlocker("conv-1", T0), "approval_pending");
});
