/**
 * Bug #80 — a saída de rotina não vira "a tarefa atual" e a tarefa do usuário
 * (com o id da planilha) sobrevive ao histórico/compactação. Prisma stubado.
 * Runner: `pnpm exec tsx --test src/conversation-task.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConversationTaskNote } from "@workspace/shared";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { loadRecentConversationMessages, appendConversationMessage } = await import("./conversations.js");
const { getConversationTaskContext, getConversationTaskLedger, listConversationResearchNotes } = await import("./runs.js");

type MessageRow = { id: string; conversationId: string; role: string; content: string; origin: string | null; createdAt: Date };
const at = (n: number) => new Date(1_700_000_000_000 + n * 1000);
const msg = (n: number, role: string, content: string, origin: string | null = null, conversationId = "conv-1"): MessageRow => ({
	id: `m${n}`,
	conversationId,
	role,
	content,
	origin,
	createdAt: at(n),
});

type Where = {
	conversationId: string;
	role: string | { in: string[] };
	origin?: null;
	OR?: Array<{ origin?: string | null; createdAt?: { gt: Date } }>;
};

function stubMessages(rows: MessageRow[]) {
	const table = prisma.conversationMessage as unknown as Record<string, unknown>;
	const original = { findFirst: table.findFirst, findMany: table.findMany, create: table.create };
	const matches = (row: MessageRow, where: Where) => {
		if (row.conversationId !== where.conversationId) return false;
		const roles = typeof where.role === "string" ? [where.role] : where.role.in;
		if (!roles.includes(row.role)) return false;
		if (where.origin === null && row.origin !== null) return false;
		if (where.OR && !where.OR.some((clause) => (clause.origin !== undefined ? row.origin === clause.origin : row.createdAt > clause.createdAt!.gt))) return false;
		return true;
	};
	table.findFirst = async ({ where }: { where: Where }) =>
		rows.filter((row) => matches(row, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
	table.findMany = async ({ where, take }: { where: Where; take: number }) =>
		rows.filter((row) => matches(row, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take);
	table.create = async ({ data }: { data: Omit<MessageRow, "id" | "createdAt" | "origin"> & { origin?: string } }) => {
		const row = { id: `new${rows.length}`, createdAt: at(1000 + rows.length), origin: null, ...data } as MessageRow;
		rows.push(row);
		return row;
	};
	return () => Object.assign(table, original);
}

test("histórico: saída de rotina anterior à última fala do usuário sai da janela; a posterior fica rotulada e agrupada", async () => {
	const rows = [
		msg(1, "user", "veja o preço do mac no mercado livre"),
		msg(2, "assistant", "O melhor preço hoje é R$ 17.499."),
		msg(3, "assistant", "Resumo das 7h - parte 1", "routine"),
		msg(4, "assistant", "Resumo das 7h - parte 2", "routine"),
		msg(5, "user", "os graficos e estilizar ela"),
		msg(6, "assistant", "Resposta ao usuário"),
		msg(7, "assistant", "Resumo das 20h - parte 1", "routine"),
		msg(8, "assistant", "Resumo das 20h - parte 2", "routine"),
		msg(9, "user", "conversa de outra pessoa", null, "conv-2"),
	];
	const restore = stubMessages(rows);
	try {
		const history = await loadRecentConversationMessages("conv-1", 40);
		const texts = history.map((m) => m.content);
		assert.ok(!texts.some((t) => t.includes("7h")), "rotina anterior ao último pedido do usuário não entra");
		assert.deepEqual(history.map((m) => m.role), ["user", "assistant", "user", "assistant", "assistant"]);
		assert.equal(texts[2], "os graficos e estilizar ela");
		const automated = history[4]!;
		assert.ok(automated.content.startsWith("[Automated run - not a user request]"));
		assert.ok(automated.content.includes("parte 1") && automated.content.includes("parte 2"));
		assert.equal(automated.content.split("[Automated run").length - 1, 1, "um único rótulo por saída");
		assert.ok(!texts.some((t) => t.includes("outra pessoa")));
	} finally {
		restore();
	}
});

test("histórico: conversa entre bots (origin bot) anterior à fala do usuário continua na janela, sem rótulo de automação", async () => {
	const rows = [
		msg(1, "user", "Mensagem do bot Ana:\nme passa o preço", "bot"),
		msg(2, "assistant", "R$ 10", "bot"),
		msg(3, "user", "oi"),
		msg(4, "assistant", "olá"),
	];
	const restore = stubMessages(rows);
	try {
		const history = await loadRecentConversationMessages("conv-1", 40);
		assert.deepEqual(history.map((m) => m.content), ["Mensagem do bot Ana:\nme passa o preço", "R$ 10", "oi", "olá"]);
	} finally {
		restore();
	}
});

test("appendConversationMessage grava origem bot com remetente e vínculo", async () => {
	const rows: Array<MessageRow & { fromBotId?: string; fromBotName?: string; botMessageId?: string }> = [];
	const restore = stubMessages(rows);
	const conversation = prisma.conversation as unknown as Record<string, unknown>;
	const originalFind = conversation.findUnique;
	conversation.findUnique = async () => ({ id: "conv-1" });
	try {
		await appendConversationMessage("conv-1", "user", "Mensagem do bot Ana:\noi", "bot", { fromBotId: "b1", fromBotName: "Ana", botMessageId: "bm1" });
		assert.equal(rows[0]!.origin, "bot");
		assert.equal(rows[0]!.fromBotName, "Ana");
		assert.equal(rows[0]!.botMessageId, "bm1");
	} finally {
		conversation.findUnique = originalFind;
		restore();
	}
});

test("histórico: conversa sem fala do usuário (proativo) mantém tudo", async () => {
	const rows = [msg(1, "assistant", "Olá! Eu sou o bot.", "routine"), msg(2, "assistant", "Segue o resumo", "routine")];
	const restore = stubMessages(rows);
	try {
		const history = await loadRecentConversationMessages("conv-1", 40);
		assert.equal(history.length, 1);
		assert.ok(history[0]!.content.includes("Olá!") && history[0]!.content.includes("Segue o resumo"));
	} finally {
		restore();
	}
});

test("appendConversationMessage só grava origem automatizada conhecida", async () => {
	const rows: MessageRow[] = [];
	const restore = stubMessages(rows);
	const conversation = prisma.conversation as unknown as Record<string, unknown>;
	const originalFind = conversation.findUnique;
	conversation.findUnique = async () => ({ id: "conv-1" });
	try {
		await appendConversationMessage("conv-1", "assistant", "saída", "routine");
		await appendConversationMessage("conv-1", "assistant", "fala", "qualquer-coisa");
		await appendConversationMessage("conv-1", "assistant", "normal");
		assert.deepEqual(rows.map((row) => row.origin), ["routine", null, null]);
	} finally {
		conversation.findUnique = originalFind;
		restore();
	}
});

type RunRow = { id: string; userId: string; conversationId: string; origin: string; objective: string; status: string; resultText: string | null; effects: unknown };

function stubRuns(rows: RunRow[], events: Array<{ runId: string; payload: unknown }>) {
	const client = prisma as unknown as Record<string, unknown>;
	const runEvent = prisma.runEvent as unknown as Record<string, unknown>;
	const original = { raw: client.$queryRaw, events: runEvent.findMany };
	const seen: Array<{ sql: string; values: unknown[] }> = [];
	client.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const isSql = (value: unknown): value is { strings: string[]; values: unknown[] } =>
			typeof value === "object" && value !== null && "strings" in value && "values" in value;
		const nested = values.filter(isSql);
		const flat = values.flatMap((value) => (isSql(value) ? value.values : [value]));
		const sql = [strings.join("?"), ...nested.map((value) => value.strings.join("?"))].join(" ");
		seen.push({ sql, values: flat });
		const conversationId = flat[0];
		const owners = flat.filter((value): value is string => typeof value === "string" && value.startsWith("user-"));
		return rows.filter((row) => row.conversationId === conversationId && owners.includes(row.userId) && row.origin === "chat");
	};
	runEvent.findMany = async ({ where }: { where: { runId: string } }) => events.filter((event) => event.runId === where.runId);
	return { seen, restore: () => { client.$queryRaw = original.raw; runEvent.findMany = original.events; } };
}

const SHEET_ID = "1z_RqTZgSPpSvjOvAWxwrAlmRrMZskL65G1q0105U2Q0";
const effect = (runId: string, step: number, callId: string, tool: string) => ({ step, tool, state: "ok", argsHash: "h", attemptId: `${runId}:${step}:${callId}:${tool}` });

test("tarefa ativa: tarefas do usuário + recurso criado (id da planilha), sem confirmação de card; dono isolado", async () => {
	const rows: RunRow[] = [
		{ id: "r3", userId: "user-a", conversationId: "conv-1", origin: "chat", objective: "confirmado: Google Planilhas: executar \"update_range\"?", status: "completed", resultText: "feito", effects: [effect("r3", 2, "toolu_2", "mcp__google_sheets__update_range")] },
		{ id: "r2", userId: "user-a", conversationId: "conv-1", origin: "chat", objective: "Tem q criar uma planilha para isso", status: "completed", resultText: null, effects: [effect("r2", 1, "toolu_1", "mcp__google_sheets__create_spreadsheet")] },
		{ id: "r1", userId: "user-a", conversationId: "conv-1", origin: "chat", objective: "veja o preço do mec", status: "completed", resultText: "R$ 17.499", effects: [] },
		{ id: "rr", userId: "user-a", conversationId: "conv-1", origin: "routine", objective: "[EXECUÇÃO DE ROTINA] resumo de e-mails", status: "completed", resultText: "25 e-mails", effects: [] },
		{ id: "rb", userId: "user-b", conversationId: "conv-1", origin: "chat", objective: "tarefa do usuário B", status: "completed", resultText: "segredo de B", effects: [] },
	];
	const events = [
		{ runId: "r2", payload: { id: "toolu_1", ok: true, summary: `Planilha criada: Monitor\nspreadsheetId: ${SHEET_ID}` } },
		{ runId: "r3", payload: { id: "toolu_2", ok: true, summary: "Intervalo A1:K1 atualizado" } },
		{ runId: "r2", payload: { id: "toolu_x", ok: true, summary: "outra chamada" } },
	];
	const { seen, restore } = stubRuns(rows, events);
	try {
		const context = await getConversationTaskContext("user-a", "conv-1", { excludeRunId: "r-current" });
		assert.deepEqual(context?.tasks.map((task) => task.objective), ["Tem q criar uma planilha para isso", "veja o preço do mec"]);
		// Mais recente primeiro: a escrita confirmada (run de "confirmado:") e a criação da planilha.
		assert.deepEqual(context?.effects.map((entry) => entry.tool), ["mcp__google_sheets__update_range", "mcp__google_sheets__create_spreadsheet"]);
		assert.ok(context?.effects[1]?.summary.includes(SHEET_ID));
		const note = buildConversationTaskNote(context);
		assert.ok(note?.includes(SHEET_ID));
		assert.ok(!note?.includes("e-mails") && !note?.includes("ROTINA"), "rotina nunca entra");
		assert.ok(!note?.includes("usuário B") && !note?.includes("segredo"));
		// A consulta é parametrizada, só de run de chat, do dono e da conversa.
		assert.ok(seen[0]!.sql.includes("'chat'"));
		assert.ok(seen[0]!.values.includes("user-a") && seen[0]!.values.includes("conv-1") && seen[0]!.values.includes("r-current"));
		// Usuário B não lê a tarefa de A, nem na mesma conversa.
		const other = await getConversationTaskContext("user-b", "conv-1");
		assert.deepEqual(other?.tasks.map((task) => task.objective), ["tarefa do usuário B"]);
		assert.equal(await getConversationTaskContext("user-c", "conv-1"), null);
		assert.equal(await getConversationTaskContext("user-a", ""), null);
		assert.equal(await getConversationTaskContext("", "conv-1"), null);
	} finally {
		restore();
	}
});

test("ledger e notas de pesquisa herdados só de runs da mesma origem (rotina não sequestra o chat)", async () => {
	const agentRun = prisma.agentRun as unknown as Record<string, unknown>;
	const original = agentRun.findMany;
	const wheres: Array<Record<string, unknown>> = [];
	agentRun.findMany = async ({ where }: { where: Record<string, unknown> }) => {
		wheres.push(where);
		return [];
	};
	try {
		await getConversationTaskLedger("user-a", "conv-1", { origin: "chat" });
		await listConversationResearchNotes("user-a", "conv-1", { origin: "chat" });
		await getConversationTaskLedger("user-a", "conv-1");
		assert.equal(wheres[0]!.origin, "chat");
		assert.equal(wheres[1]!.origin, "chat");
		assert.ok(!("origin" in wheres[2]!));
	} finally {
		agentRun.findMany = original;
	}
});
